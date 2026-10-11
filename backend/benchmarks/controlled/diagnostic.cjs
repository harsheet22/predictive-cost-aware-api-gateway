'use strict';
const fs = require('fs');
const path = require('path');
const { sha } = require('./common.cjs');

// Deliberately separate from matrix options: no seed/profile/duration overrides,
// alternative arms, capacity changes or shortened observation boundary.
function parseDiagnostic(argv) {
  const options = { mode: 'diagnostic', experiment: 'A', arm: 'baseline', drainSec: 300, maxOutstanding: 16384 };
  const flags = { '--mode': 'mode', '--trace': 'tracePath', '--experiment': 'experiment', '--arm': 'arm', '--drain': 'drainSec', '--expected-trace-sha256': 'expectedTraceSha256' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]], value = argv[i + 1];
    if (!key || !value || seen.has(key)) throw new Error(`Unknown, missing or duplicate diagnostic option ${argv[i]}`);
    seen.add(key); options[key] = key === 'drainSec' ? Number(value) : value;
  }
  if (options.mode !== 'diagnostic' || options.experiment !== 'A' || options.arm !== 'baseline' ||
      options.drainSec !== 300 || !options.tracePath) {
    throw new Error('Diagnostic mode requires a saved --trace, exactly A/baseline and the existing 300-second drain');
  }
  if (options.expectedTraceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedTraceSha256)) throw new Error('Invalid expected source-file SHA-256');
  return options;
}

function loadSavedTrace(file, expectedSha256) {
  const sourcePath = fs.realpathSync(path.resolve(file));
  const bytes = fs.readFileSync(sourcePath);
  const fileHash = sha(bytes);
  if (expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(expectedSha256) || fileHash !== expectedSha256)) throw new Error('Saved trace source-file SHA-256 mismatch');
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Invalid saved trace JSON'); }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const config = require('../../src/config');
  if (!object(input) || typeof input.profile !== 'string' || !Object.hasOwn(config.simulator.profiles, input.profile) ||
      !Number.isSafeInteger(input.seed) || !Number.isFinite(input.durationSec) || input.durationSec <= 0 || !Number.isFinite(input.durationSec * 1000) ||
      !Array.isArray(input.requests) || !input.requests.length || typeof input.hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.hash)) {
    throw new Error('Invalid saved trace metadata or request list');
  }
  const ids = new Set(); let previous = -1;
  for (const request of input.requests) {
    if (!object(request) || typeof request.requestId !== 'string' || !request.requestId.trim() || ids.has(request.requestId) ||
        typeof request.type !== 'string' || !Object.hasOwn(config.requestTypes, request.type) || !['low', 'normal', 'high'].includes(request.priority) ||
        !['full', 'reduced'].includes(request.precision) || !Number.isSafeInteger(request.payloadSize) || request.payloadSize < 0 ||
        !object(request.parameters) || !Number.isSafeInteger(request.parameters.iterations) || request.parameters.iterations <= 0 ||
        !Number.isSafeInteger(request.parameters.itemId) || request.parameters.itemId < 0 ||
        typeof request.clientId !== 'string' || !request.clientId.trim() ||
        typeof request.arrivalTs !== 'string' || !Number.isFinite(Date.parse(request.arrivalTs)) ||
        !Number.isSafeInteger(request.arrivalOffsetMs) || request.arrivalOffsetMs < previous || request.arrivalOffsetMs < 0 ||
        request.arrivalOffsetMs > input.durationSec * 1000) {
      throw new Error('Invalid saved trace request: identity, fields or arrival order/horizon');
    }
    ids.add(request.requestId); previous = request.arrivalOffsetMs;
  }
  // Same convention as common.trace(): hash JSON.stringify(requests), not the file.
  const requestHash = sha(JSON.stringify(input.requests));
  if (requestHash !== input.hash) throw new Error('Saved trace embedded hash mismatch');
  return { input, bytes, evidence: { sourcePath, sourceFileSha256: fileHash, embeddedTraceHash: input.hash,
    computedTraceHash: requestHash, byteLength: bytes.length, profile: input.profile, seed: input.seed,
    durationSec: input.durationSec, requestCount: input.requests.length, validationPassed: true } };
}

module.exports = { parseDiagnostic, loadSavedTrace };
