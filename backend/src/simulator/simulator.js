'use strict';

/**
 * Workload simulator.
 *
 * Produces a DETERMINISTIC, timestamped stream of requests for a given seed.
 * The experiment runner replays the identical array through both gateways, so
 * any difference in outcome is attributable to the gateway, not the load.
 */
const config = require('../config');
const jobs = require('../workload/jobs');
const dist = require('./distributions');

/** Resolve a profile name (or explicit rate) into effective settings. */
function resolveProfile({ profile, arrivalRatePerSec }) {
  const profiles = config.simulator.profiles;
  const name = profile && profiles[profile] ? profile : config.simulator.defaultProfile;
  const base = profiles[name];
  return {
    name,
    arrivalRatePerSec: arrivalRatePerSec != null ? arrivalRatePerSec : base.arrivalRatePerSec,
    typeWeights: base.typeWeights,
  };
}

/** Choose an item id, biased toward a small hot set (cache-friendly). */
function pickItemId(rng) {
  const { totalItems, hotKeys } = config.data;
  const bias = config.simulator.hotKeyBias;
  if (rng() < bias) return Math.floor(rng() * hotKeys);
  return Math.floor(rng() * totalItems);
}

/**
 * Generate a request stream.
 *
 * @param {object} [options]
 * @param {string} [options.profile]        profile name
 * @param {number} [options.arrivalRatePerSec]
 * @param {number} [options.durationSec]    stream length in seconds
 * @param {number} [options.count]          optional hard cap on requests
 * @param {number} [options.seed]           PRNG seed (default 1)
 * @param {string} [options.startTimeIso]   wall clock base for arrivalTs
 * @returns {Array<object>} requests, ordered by arrival, each with arrivalOffsetMs
 */
function generateRequests(options = {}) {
  const resolved = resolveProfile(options);
  const durationSec = options.durationSec != null ? options.durationSec : 30;
  const seed = options.seed != null ? options.seed : 1;
  const rng = dist.mulberry32(seed);
  const startMs = options.startTimeIso ? Date.parse(options.startTimeIso) : Date.now();
  const endOffsetMs = durationSec * 1000;
  const typeWeights = options.typeWeights || resolved.typeWeights;

  const requests = [];
  let offsetMs = 0;

  while (offsetMs <= endOffsetMs) {
    offsetMs += dist.exponentialIntervalMs(resolved.arrivalRatePerSec, rng);
    if (offsetMs > endOffsetMs) break;

    const type = dist.weightedPick(typeWeights, rng);
    const request = {
      requestId: dist.uuid(rng),
      type,
      payloadSize: dist.randInt(config.simulator.payloadBytes.min, config.simulator.payloadBytes.max, rng),
      priority: dist.weightedPick(config.simulator.priorityWeights, rng),
      precision: 'full',
      parameters: { itemId: pickItemId(rng) },
      clientId: `sim-client-${1 + Math.floor(rng() * 5)}`,
      arrivalOffsetMs: Math.round(offsetMs),
      arrivalTs: new Date(startMs + offsetMs).toISOString(),
    };
    // Pre-compute the abstract iteration count so the request is self-describing.
    request.parameters.iterations = jobs.iterationsFor(request);

    requests.push(request);
    if (options.count && requests.length >= options.count) break;
  }

  return requests;
}

/**
 * Replay a stream by invoking `onRequest(request, index)` after the correct
 * inter-arrival delay. Both gateways can be driven from the same array.
 */
async function replay(requests, onRequest, { speed = 1 } = {}) {
  let previousOffset = 0;
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const deltaMs = (request.arrivalOffsetMs - previousOffset) / speed;
    previousOffset = request.arrivalOffsetMs;
    if (deltaMs > 0) await jobs.wait(deltaMs);
    onRequest(request, i);
  }
}

module.exports = { generateRequests, replay, resolveProfile };
