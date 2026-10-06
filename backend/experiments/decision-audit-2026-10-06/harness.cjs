'use strict';

// Observation-only wrappers. All original decisions, predictions, execution,
// rates, costs, queue limits, and simulator replay are called unchanged.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { performance } = require('perf_hooks');
const root = path.resolve(__dirname, '../../..');
const config = require('../../src/config');
const MetricsStore = require('../../src/metrics/metricsStore');
const BaselineGateway = require('../../src/gateways/baselineGateway');
const PredictiveGateway = require('../../src/gateways/predictiveGateway');
const { generateRequests, replay } = require('../../src/simulator/simulator');
const context = new AsyncLocalStorage();
const seed = 42;
const durationSec = 5;
const profiles = ['normal', 'demo', 'stress', 'burst', 'heavy_tail', 'overload'];
const quantiles = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return Object.fromEntries([['min', 0], ['p50', .5], ['p90', .9], ['p95', .95], ['p99', .99], ['max', 1]]
    .map(([name, fraction]) => [name, sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]]));
};
function hashes() {
  const result = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const filename = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(filename);
      else result[filename] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, filename))).digest('hex');
    }
  }
  for (const directory of ['backend/src', 'frontend/src', 'ml-service/app', 'ml-service/models', 'ml-service/training']) visit(directory);
  return result;
}
const before = hashes();
const report = { startedAt: new Date().toISOString(), seed, durationSec, percentileMethod: 'nearest rank',
  methodology: 'Fresh gateways per profile; baseline then predictive; unchanged replay; one excluded direct HTTP warmup before predictive; AsyncLocalStorage identifies every admission attempt. Used state was captured by the gateway before prediction. Fresh state at _make is separately observed. No per-request console/file I/O during replay.',
  config, sourceHashesBefore: before, results: [] };
const save = () => fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(report, null, 2));

async function run(gateway, requests) {
  const pending = new Set();
  const outcomes = new Map();
  const failures = [];
  gateway.metrics.markExperimentStart(durationSec);
  const started = performance.now();
  await replay(requests, request => {
    const task = gateway.handle(request).then(outcome => outcomes.set(request.requestId, outcome))
      .catch(error => failures.push({ requestId: request.requestId, message: error.message }));
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  while (pending.size) await new Promise(resolve => setTimeout(resolve, 25));
  gateway.metrics.markExperimentEnd();
  return { elapsedSec: (performance.now() - started) / 1000, snapshot: gateway.metrics.snapshot(), outcomes, failures };
}

async function profileRun(profile) {
  if (!config.simulator.profiles[profile]) throw new Error(`Missing profile ${profile}`);
  const requests = generateRequests({ profile, durationSec, seed });
  const baselineMetrics = new MetricsStore('baseline');
  const predictiveMetrics = new MetricsStore('predictive');
  const baseline = new BaselineGateway(baselineMetrics);
  const predictive = new PredictiveGateway(predictiveMetrics);
  const attempts = [];
  const details = [];
  const decide = predictive.engine.decide.bind(predictive.engine);
  predictive.engine.decide = (request, state) => context.run({ request, state: { ...state } }, () => decide(request, state));
  const make = predictive.engine._make.bind(predictive.engine);
  predictive.engine._make = (...args) => {
    const result = make(...args);
    const { request, state } = context.getStore();
    const freshActive = predictive.rate.active;
    const freshQueue = predictive.rate.queue.length;
    attempts.push({ requestId: request.requestId, decisionAtEpochMs: Date.now(),
      predictedExecutionMs: result.predictedCostMs, predictedUsd: result.predictedCloudCostUsd,
      remainingBudgetUsd: result.budgetRemainingUsd, executionActiveUsed: state.concurrent,
      executionQueueUsed: state.queueDepth, executionPressureUsedPct: state.cpuPct,
      freshExecutionActive: freshActive, freshExecutionQueue: freshQueue,
      freshExecutionPressurePct: Math.max(freshActive / config.predictive.maxConcurrent, freshQueue / config.predictive.maxQueue) * 100,
      priority: request.priority, admissionDecision: result.decision, admissionReason: result.reason });
    return result;
  };
  const recordDetail = predictiveMetrics.recordMLPredictionDetail.bind(predictiveMetrics);
  predictiveMetrics.recordMLPredictionDetail = detail => { recordDetail(detail); details.push({ ...detail }); };
  try {
    console.log(JSON.stringify({ profile, phase: 'baseline', requests: requests.length }));
    const b = await run(baseline, requests);
    const warmup = generateRequests({ profile: 'normal', count: 1, seed })[0];
    await predictive.mlClient.predict(warmup); // excludes queue/store/decision/budget
    console.log(JSON.stringify({ profile, phase: 'predictive' }));
    const p = await run(predictive, requests);
    const requestRows = requests.map(request => ({ request, baselineOutcome: b.outcomes.get(request.requestId) || null,
      finalOutcome: p.outcomes.get(request.requestId) || null }));
    const groupedAttempts = new Map();
    for (const attempt of attempts) {
      if (!groupedAttempts.has(attempt.requestId)) groupedAttempts.set(attempt.requestId, []);
      groupedAttempts.get(attempt.requestId).push(attempt);
      const outcome = p.outcomes.get(attempt.requestId);
      attempt.finalDecision = outcome?.decision || null;
      attempt.finalReason = outcome?.reason || null;
    }
    for (const row of requestRows) row.decisionAttempts = groupedAttempts.get(row.request.requestId) || [];
    const firstAttempts = Array.from(groupedAttempts.values(), entries => entries[0]);
    const counts = attempts.reduce((acc, a) => { const key = `${a.admissionDecision}:${a.admissionReason}`; acc[key] = (acc[key] || 0) + 1; return acc; }, {});
    const summary = { profile, requests: requests.length, admissionAttempts: attempts.length,
      baseline: { elapsedSec: b.elapsedSec, snapshot: b.snapshot, failures: b.failures },
      predictive: { elapsedSec: p.elapsedSec, snapshot: p.snapshot, failures: p.failures, queue: predictive.predictionQueue.stats() },
      firstPredictionMs: quantiles(firstAttempts.map(a => a.predictedExecutionMs)),
      firstPredictionUsd: quantiles(firstAttempts.map(a => a.predictedUsd)),
      remainingBudgetUsd: quantiles(attempts.map(a => a.remainingBudgetUsd)),
      executionPressureUsedPct: quantiles(attempts.map(a => a.executionPressureUsedPct)),
      freshExecutionPressurePct: quantiles(attempts.map(a => a.freshExecutionPressurePct)),
      maxExecutionActiveUsed: Math.max(0, ...attempts.map(a => a.executionActiveUsed)),
      maxExecutionQueueUsed: Math.max(0, ...attempts.map(a => a.executionQueueUsed)),
      maxFreshExecutionActive: Math.max(0, ...attempts.map(a => a.freshExecutionActive)),
      maxFreshExecutionQueue: Math.max(0, ...attempts.map(a => a.freshExecutionQueue)),
      staleStateCount: attempts.filter(a => a.executionActiveUsed !== a.freshExecutionActive || a.executionQueueUsed !== a.freshExecutionQueue).length,
      expensiveCount: attempts.filter(a => a.predictedUsd > config.predictive.budget.cheapShare * a.remainingBudgetUsd).length,
      insufficientBudgetCount: attempts.filter(a => a.predictedUsd >= a.remainingBudgetUsd).length,
      usedSoftPressureCount: attempts.filter(a => a.executionPressureUsedPct >= config.predictive.utilization.softPct).length,
      usedFullConcurrencyCount: attempts.filter(a => a.executionActiveUsed >= config.predictive.maxConcurrent).length,
      admissionReasons: counts, meanExecutionMs: quantiles(requestRows.filter(r => r.finalOutcome?.status === 200).map(r => r.finalOutcome.actualCostMs)),
      actualExecutionMeanMs: requestRows.filter(r => r.finalOutcome?.status === 200).reduce((sum, r) => sum + r.finalOutcome.actualCostMs, 0) / (p.snapshot.processed || 1),
      validation: { outcomeCount: p.outcomes.size, inFlight: p.snapshot.inFlight,
        mlSamples: p.snapshot.ml.predictionCount, details: details.length,
        attemptsWithOutcome: attempts.every(a => a.finalDecision != null) } };
    fs.writeFileSync(path.join(__dirname, `${profile}-requests.json`), JSON.stringify({ profile, seed, durationSec, requestRows, predictionTimings: details }, null, 2));
    report.results.push(summary);
    save();
    console.log(JSON.stringify({ profile, complete: true, decisions: { ALLOW: p.snapshot.allowed, DOWNGRADE: p.snapshot.downgraded, DELAY: p.snapshot.delayed, REJECT: p.snapshot.rejected }, mlRate: p.snapshot.ml.predictionThroughputPerSec, errors: p.snapshot.ml.errorCount }));
  } finally {
    clearInterval(baselineMetrics._timer);
    clearInterval(predictiveMetrics._timer);
  }
}

(async () => {
  report.mlHealth = await (await fetch('http://localhost:8000/health')).json();
  save();
  for (const profile of profiles) await profileRun(profile);
  report.sourceHashesAfter = hashes();
  report.sourcesUnchanged = JSON.stringify(before) === JSON.stringify(report.sourceHashesAfter);
  report.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ finished: true, sourcesUnchanged: report.sourcesUnchanged }));
})().catch(error => { report.error = error.stack; save(); console.error(error); process.exitCode = 1; });
