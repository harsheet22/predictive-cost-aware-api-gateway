'use strict';
const { sha } = require('../controlled/common.cjs');
const config = require('../../src/config');
const LIMITS = Object.freeze({ maxRate: 100, maxDurationSec: 30, maxRequests: 5000, maxOutstanding: 512, maxDrainSec: 300 });
function validateTrace(input) {
  if (Buffer.byteLength(JSON.stringify(input) || '') > 2 * 1024 * 1024) throw new Error('External trace exceeds 2 MiB');
  if (!input || !Object.hasOwn(config.simulator.profiles, input.profile) || !Number.isSafeInteger(input.seed) ||
      !Number.isFinite(input.durationSec) || input.durationSec <= 0 || input.durationSec > LIMITS.maxDurationSec ||
      !Number.isFinite(input.rate) || input.rate <= 0 || input.rate > LIMITS.maxRate ||
      !Array.isArray(input.requests) || !input.requests.length || input.requests.length > LIMITS.maxRequests) throw new Error('Invalid or oversized external trace');
  const ids = new Set(); let previous = -1;
  for (const r of input.requests) {
    if (!r || typeof r.requestId !== 'string' || r.requestId.length > 100 || !r.requestId || ids.has(r.requestId) ||
        !Object.hasOwn(config.requestTypes, r.type) || !['low', 'normal', 'high'].includes(r.priority) || r.precision !== 'full' ||
        !Number.isSafeInteger(r.payloadSize) || r.payloadSize < 0 || r.payloadSize > 1024 * 1024 ||
        !Number.isSafeInteger(r.parameters?.iterations) || r.parameters.iterations < 1 || r.parameters.iterations > 10000000 ||
        !Number.isFinite(r.arrivalOffsetMs) || r.arrivalOffsetMs < previous || r.arrivalOffsetMs < 0 || r.arrivalOffsetMs > input.durationSec * 1000) throw new Error('Invalid external request or arrival order');
    ids.add(r.requestId); previous = r.arrivalOffsetMs;
  }
  if (input.hash !== sha(JSON.stringify(input.requests))) throw new Error('Trace hash mismatch');
  return input;
}
function makeTrace({ profile, rate, seed, durationSec }) {
  const requests = require('../../src/simulator/simulator').generateRequests({ profile, arrivalRatePerSec: rate, seed, durationSec, startTimeIso: '2000-01-01T00:00:00.000Z' });
  return validateTrace({ profile, rate, seed, durationSec, requests, hash: sha(JSON.stringify(requests)) });
}
function validateClient(input, client) {
  if (!client || client.traceHash !== input.hash || !Array.isArray(client.rows) || client.rows.length !== input.requests.length ||
      !Number.isFinite(client.elapsedMs) || client.elapsedMs < 0 || !Number.isInteger(client.unresolvedAtCutoff) || client.unresolvedAtCutoff < 0) throw new Error('Invalid client observations');
  const byId = new Map(input.requests.map(r => [r.requestId, r])); const seen = new Set();
  for (const row of client.rows) {
    if (!byId.has(row.requestId) || seen.has(row.requestId) || row.scheduledMs !== byId.get(row.requestId).arrivalOffsetMs ||
        ![0, 1].includes(row.attempts) || (row.dispatchMs != null && (!Number.isFinite(row.dispatchMs) || row.dispatchMs < row.scheduledMs)) ||
        (row.responseMs != null && (!Number.isFinite(row.responseMs) || row.responseMs < row.dispatchMs))) throw new Error('Invalid client request accounting');
    seen.add(row.requestId);
  }
}
module.exports = { LIMITS, validateTrace, makeTrace, validateClient };
