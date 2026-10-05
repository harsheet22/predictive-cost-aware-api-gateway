'use strict';

/**
 * Job catalogue + the raw work functions.
 *
 * These are intentionally shared by BOTH gateways. "Same workload" means the
 * baseline and the predictive gateway import this exact module -- only how the
 * work is admitted/scheduled differs.
 */
const crypto = require('crypto');
const config = require('../config');

/** Definition for a request type (cpuUnits, ioMs, ...). */
function typeDefinition(type) {
  return config.requestTypes[type];
}

/** How many synchronous SHA-256 rounds this request should burn. */
function iterationsFor(request) {
  const def = typeDefinition(request.type);
  if (!def) throw new Error(`Unknown request type: ${request.type}`);
  // payload contributes extra CPU units per 1000 bytes
  const payloadCpu = ((request.payloadSize || 0) / 1000) * (def.payloadCpuFactor || 0);
  const units = def.cpuUnits + payloadCpu;
  const iterations = Math.round(units * config.executor.hashIterationsPerUnit);
  return Math.max(config.executor.minHashIterations, iterations);
}

/** Simulated async upstream/database latency for this request. */
function ioMsFor(request) {
  const def = typeDefinition(request.type);
  if (!def) throw new Error(`Unknown request type: ${request.type}`);
  return def.ioMs;
}

/**
 * Hash a contiguous range and return the running digest. Pure function of
 * (seed, from, count) so it is safe to resume after yielding.
 */
function hashRange(seed, from, count) {
  let acc = seed;
  const end = from + count;
  for (let i = from; i < end; i++) {
    acc = crypto
      .createHash('sha256')
      .update(acc)
      .update(String(i))
      .digest('hex');
  }
  return acc;
}

/** Fully synchronous CPU work (blocks the event loop) - the default path. */
function hashRounds(iterations, seed) {
  return hashRange(String(seed), 0, iterations);
}

/**
 * CPU work with an optional safety valve: if `syncIterationCap` is exceeded the
 * remaining work is processed in chunks, yielding to the event loop between
 * them. Defaults keep normal jobs fully synchronous so the baseline's event
 * loop genuinely saturates.
 */
async function burnCpu(iterations, seed) {
  const cap = config.executor.syncIterationCap;
  if (!cap || iterations <= cap) return hashRounds(iterations, seed);

  let acc = String(seed);
  let done = 0;
  while (done < iterations) {
    const count = Math.min(cap, iterations - done);
    acc = hashRange(acc, done, count);
    done += count;
    if (done < iterations) await new Promise((resolve) => setImmediate(resolve));
  }
  return acc;
}

/** Async, non-blocking simulated I/O. */
function wait(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  typeDefinition,
  iterationsFor,
  ioMsFor,
  hashRange,
  hashRounds,
  burnCpu,
  wait,
};
