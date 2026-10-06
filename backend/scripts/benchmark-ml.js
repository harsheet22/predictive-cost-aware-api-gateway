'use strict';

// Profile replay is the existing simulator's replay(), unchanged. Independent
// observations also work against the pre-fix duplicate-counting metrics store.
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const config = require('../src/config');
const MetricsStore = require('../src/metrics/metricsStore');
const PredictiveGateway = require('../src/gateways/predictiveGateway');
const { generateRequests, replay } = require('../src/simulator/simulator');

const label = process.argv[2] || 'after';
const profiles = (process.argv[3] || 'normal,demo,stress,burst,heavy_tail').split(',');
const durationSec = Number(process.argv[4] || 5);
const print = console.log.bind(console);
// Keep per-request console I/O identical for both benchmark configurations.
console.log = () => {};
const nativeFetch = global.fetch;
let serverSamples = [];
global.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  if (String(args[0]).endsWith('/predict')) {
    const timing = Object.fromEntries((response.headers.get('server-timing') || '')
      .split(',').map(part => {
        const [name, duration] = part.trim().split(';dur=');
        return [name, Number(duration)];
      }));
    serverSamples.push(timing);
  }
  return response;
};

async function runProfile(profile) {
  const metrics = new MetricsStore('predictive');
  const gateway = new PredictiveGateway(metrics);
  const details = [];
  const httpTimes = [];
  let firstPrediction;
  let lastPrediction;
  let peakQueued = 0;
  let handleFailures = 0;
  serverSamples = [];
  const record = metrics.recordMLPredictionDetail.bind(metrics);
  metrics.recordMLPredictionDetail = detail => { details.push(detail); record(detail); };
  const predict = gateway.mlClient.predict.bind(gateway.mlClient);
  gateway.mlClient.predict = async (...args) => {
    const started = performance.now();
    try { return await predict(...args); }
    finally { httpTimes.push(performance.now() - started); }
  };
  const queueRun = gateway.predictionQueue.run.bind(gateway.predictionQueue);
  gateway.predictionQueue.run = task => {
    firstPrediction ??= performance.now();
    const result = queueRun(task);
    peakQueued = Math.max(peakQueued, gateway.predictionQueue.stats().queued);
    return result.finally(() => { lastPrediction = performance.now(); });
  };
  // Warm the HTTP connection/model before collecting profile measurements.
  const warmup = generateRequests({ profile: 'normal', count: 1, seed: 42 })[0];
  await predict(warmup);
  serverSamples = [];
  const requests = generateRequests({ profile, durationSec, seed: 42 });
  const pending = new Set();
  const started = performance.now();
  try {
    await replay(requests, request => {
      const task = gateway.handle(request).catch(error => {
        handleFailures++;
        console.error(`[benchmark] ${request.requestId}: ${error.message}`);
      });
      pending.add(task);
      task.finally(() => pending.delete(task));
    });
    while (pending.size) await new Promise(resolve => setTimeout(resolve, 25));
    const mean = values => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
    const round = value => value == null ? null : Number(value.toFixed(3));
    const processingMs = mean(serverSamples.map(t => t.fastapi).filter(Number.isFinite));
    const httpMs = mean(httpTimes);
    const report = {
      profile, durationSec, seed: 42, requests: requests.length,
      mlConcurrency: config.predictive.mlConcurrency,
      predictions: details.length,
      predictionThroughputPerSec: round(details.length / ((lastPrediction - firstPrediction) / 1000)),
      avgQueueWaitMs: round(mean(details.map(d => d.queueWaitMs))),
      avgHttpMs: round(httpMs),
      avgNetworkResidualMs: processingMs == null ? null : round(Math.max(0, httpMs - processingMs)),
      avgFastapiMs: round(processingMs),
      avgInferenceMs: round(mean(serverSamples.map(t => t.rf).filter(Number.isFinite))),
      avgTotalPredictionMs: round(mean(details.map(d => d.totalLatencyMs))),
      mlErrorCount: details.filter(d => !d.success).length,
      fallbackCount: details.filter(d => d.fallback).length,
      handleFailures, peakQueued, elapsedSec: round((performance.now() - started) / 1000),
      snapshot: metrics.snapshot(),
    };
    print(JSON.stringify({ ...report, snapshot: undefined }));
    return report;
  } finally { clearInterval(metrics._timer); }
}

(async () => {
  const results = [];
  for (const profile of profiles) results.push(await runProfile(profile));
  const directory = path.join(__dirname, '..', 'experiments', 'ml-pipeline');
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${label}.json`);
  fs.writeFileSync(filename, JSON.stringify({ label, recordedAt: new Date().toISOString(), results }, null, 2));
  print(`Report: ${filename}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
