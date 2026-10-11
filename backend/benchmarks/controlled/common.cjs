'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function hashes(excludeDirectory) {
  const result = {};
  const excluded = excludeDirectory ? path.relative(root, excludeDirectory).replaceAll('\\', '/') : null;
  function visit(relative) {
    if (relative.replaceAll('\\', '/') === excluded) return;
    for (const e of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (['node_modules', '.venv', '__pycache__', '.git', 'dist'].includes(e.name)) continue;
      const file = path.join(relative, e.name);
      if (e.isDirectory()) visit(file);
      else result[file.replaceAll('\\', '/')] = sha(fs.readFileSync(path.join(root, file)));
    }
  }
  for (const directory of ['backend/src', 'backend/test', 'frontend', 'ml-service/app', 'ml-service/models', 'ml-service/training', 'ml-service/data', 'backend/experiments', 'backend/benchmarks/controlled']) {
    // Include prior benchmark results too; exclude only this invocation's output.
    if (directory !== 'backend/experiments') visit(directory);
    else for (const e of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const item = path.join(directory, e.name);
      if (e.isDirectory()) visit(item); else result[item.replaceAll('\\', '/')] = sha(fs.readFileSync(path.join(root, item)));
    }
  }
  for (const file of ['package.json', 'package-lock.json', 'ml-service/requirements.txt']) if (fs.existsSync(path.join(root, file))) result[file] = sha(fs.readFileSync(path.join(root, file)));
  return result;
}
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2), { flag: 'wx' });
}
function stats(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  const q = p => a.length ? a[Math.ceil(a.length * p) - 1] : null;
  return { n: a.length, mean: a.length ? a.reduce((s, x) => s + x, 0) / a.length : null, p50: q(.5), p95: q(.95), p99: q(.99), max: a.length ? a.at(-1) : null };
}
function trace(profile, seed, durationSec) {
  const config = require('../../src/config');
  if (!Object.hasOwn(config.simulator.profiles, profile)) throw new Error(`Unknown profile: ${profile}`);
  if (!(durationSec > 0 && Number.isFinite(durationSec)) || !Number.isSafeInteger(seed)) throw new Error('Invalid trace options');
  const requests = require('../../src/simulator/simulator').generateRequests({ profile, seed, durationSec, startTimeIso: '2000-01-01T00:00:00.000Z' });
  return { profile, seed, durationSec, requests, hash: sha(JSON.stringify(requests)) };
}
const failureReasons = new Set(['ml_prediction_failed', 'execution_error']);
function category(outcome) {
  if (!outcome) return 'unresolved';
  if (outcome.status === 200) return 'completed';
  if (outcome.status >= 500 && (failureReasons.has(outcome.reason) || outcome.reason === 'benchmark_handler_error')) return 'failed';
  return 'rejected';
}
function summarize(input, client, server) {
  const ids = new Set(input.requests.map(r => r.requestId));
  const clients = new Map(client.rows.map(r => [r.requestId, r]));
  const servers = new Map(server.rows.map(r => [r.requestId, r]));
  const successful = server.rows.filter(r => category(r.outcome) === 'completed');
  const clientSuccessful = client.rows.filter(r => category(r.outcome) === 'completed');
  const counts = { offered: ids.size, dispatched: client.rows.filter(r => r.dispatchMs != null).length,
    serverIncoming: server.rows.length, completed: successful.length, clientCompleted: clientSuccessful.length,
    rejected: server.rows.filter(r => category(r.outcome) === 'rejected').length,
    failed: server.rows.filter(r => category(r.outcome) === 'failed').length,
    serverUnresolved: server.rows.filter(r => !r.outcome).length,
    notDispatched: client.rows.filter(r => r.dispatchMs == null).length,
    transportErrors: client.rows.filter(r => r.transportError).length,
    dispatchedWithoutServerEntry: client.rows.filter(r => r.dispatchMs != null && !servers.has(r.requestId)).length,
    clientUnresolved: client.rows.filter(r => r.dispatchMs != null && !r.outcome).length };
  const lateness = stats(client.rows.map(r => r.dispatchMs == null ? null : r.dispatchMs - r.scheduledMs));
  const checks = {
    traceHashMatches: client.traceHash === input.hash && server.traceHash === input.hash,
    uniqueClientIds: clients.size === client.rows.length,
    uniqueServerIds: servers.size === server.rows.length,
    allOffersRecorded: clients.size === ids.size && [...ids].every(id => clients.has(id)),
    noUnexpectedIds: [...clients.keys(), ...servers.keys()].every(id => ids.has(id)),
    serverCountsBalance: counts.serverIncoming === counts.completed + counts.rejected + counts.failed + counts.serverUnresolved,
    countersBalance: server.snapshot.incoming === counts.serverIncoming && server.snapshot.inFlight === counts.serverUnresolved && server.snapshot.processed === counts.completed,
    completeObservation: counts.serverUnresolved === 0 && counts.dispatchedWithoutServerEntry === 0 && counts.clientUnresolved === 0,
    dispatchCapacity: counts.notDispatched === 0,
    timing: lateness.n > 0 && lateness.p99 <= 20 && client.rows.filter(r => r.dispatchMs != null && r.dispatchMs <= input.durationSec * 1000 + 20).length >= ids.size * .99,
    clientServerAgreement: server.rows.every(r => !r.outcome || !clients.get(r.requestId)?.outcome ||
      JSON.stringify(r.outcome) === JSON.stringify(clients.get(r.requestId).outcome)),
    noRetries: client.rows.every(r => r.attempts === (r.dispatchMs == null ? 0 : 1)),
  };
  const decisions = {}, reasons = {}, quality = {};
  for (const r of server.rows) if (r.outcome) {
    decisions[r.outcome.decision] = (decisions[r.outcome.decision] || 0) + 1;
    reasons[r.outcome.reason] = (reasons[r.outcome.reason] || 0) + 1;
    if (r.outcome.status === 200) {
      const key = r.outcome.cached ? 'cached' : r.execution?.precision || r.outcome.precision || 'full';
      quality[key] = (quality[key] || 0) + 1;
    }
  }
  const elapsedSec = Math.max(input.durationSec, client.elapsedMs / 1000);
  const totalCost = server.snapshot.cost.estimatedCloudCostUsd;
  return { counts, checks, valid: Object.values(checks).every(Boolean), dispatchLatenessMs: lateness,
    latency: { clientSuccessMs: stats(clientSuccessful.map(r => r.responseMs - r.dispatchMs)),
      scheduledSuccessMs: stats(clientSuccessful.map(r => r.responseMs - r.scheduledMs)),
      gatewaySuccessMs: stats(successful.map(r => r.gatewayEndMs - r.gatewayEntryMs)),
      gatewayAllTerminalMs: stats(server.rows.filter(r => r.outcome).map(r => r.gatewayEndMs - r.gatewayEntryMs)) },
    throughput: { denominatorSec: elapsedSec, offeredPerSec: ids.size / input.durationSec,
      dispatchedDuringHorizonPerSec: client.rows.filter(r => r.dispatchMs != null && r.dispatchMs <= input.durationSec * 1000).length / input.durationSec,
      completedDuringHorizonPerSec: clientSuccessful.filter(r => r.responseMs <= input.durationSec * 1000).length / input.durationSec,
      completedIncludingDrainPerSec: clientSuccessful.length / elapsedSec },
    sla: { targetMs: server.config.sla.targetLatencyMs, gatewayMet: successful.filter(r => r.outcome.slaMet).length,
      gatewayDenominator: counts.serverIncoming,
      clientMet: clientSuccessful.filter(r => r.responseMs - r.dispatchMs <= server.config.sla.targetLatencyMs).length,
      offeredDenominator: ids.size,
      scheduledMet: clientSuccessful.filter(r => r.responseMs - r.scheduledMs <= server.config.sla.targetLatencyMs).length },
    finalDecisions: decisions, finalReasons: reasons, quality, firstDecisionEngine: server.snapshot.decisionEngine,
    predictionGate: server.snapshot.predictionGate, ml: server.snapshot.ml,
    predictionQueueWaitMs: stats(server.rows.map(r => r.predictionStart?.actualWaitMs)),
    httpMs: stats(server.rows.map(r => r.prediction?.timings?.httpMs)),
    inferenceMs: stats(server.rows.map(r => r.prediction?.timings?.inferenceMs)),
    budgetWaitMs: stats(server.rows.map(r => r.budgetWaitMs)),
    executionQueueWaitMs: stats(server.rows.map(r => r.executionStartMs != null && r.executionQueuedMs != null ? r.executionStartMs - r.executionQueuedMs : null)),
    cost: { label: 'Synthetic execution estimate; excludes ML/waiting/idle infrastructure', totalUsd: totalCost,
      perSuccessfulCompletionUsd: counts.completed ? totalCost / counts.completed : null },
    resources: server.resources, queuePeaks: server.queuePeaks,
    limitations: ['Synthetic jobs and execution-cost constants are not AWS billing.', 'Per-request executor cpuMs overlaps concurrent jobs; do not sum it as total CPU.',
      'Single-host processes share CPU resources.', 'Policy arm has additional budget buffering; its effect is part of the policy package, not isolated forest value.'] };
}
module.exports = { root, sha, hashes, write, stats, trace, category, summarize };
