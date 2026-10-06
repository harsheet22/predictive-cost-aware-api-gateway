'use strict';
const MetricsStore = require('../src/metrics/metricsStore');
const PredictiveGateway = require('../src/gateways/predictiveGateway');
const { app, gateways } = require('../src/index');
const request = { requestId: 'test', type: 'db_query', payloadSize: 256,
  parameters: { iterations: 1200 }, priority: 'normal', precision: 'full' };
const prediction = { predictedCostMs: 30, predictedCloudCostUsd: 0.000001,
  costTier: 'medium', confidence: 0.7, modelVersion: 'rf-test',
  timings: { httpMs: 85, fastapiMs: 75, inferenceMs: 60, networkResidualMs: 10, workerQueueMs: 1 } };
let metrics;
let gateway;
beforeEach(() => { metrics = new MetricsStore('test'); gateway = new PredictiveGateway(metrics); });
afterEach(() => { clearInterval(metrics._timer); jest.restoreAllMocks(); });
afterAll(() => { for (const g of Object.values(gateways)) clearInterval(g.metrics._timer); });

test('successful prediction is counted exactly once with true inference duration', async () => {
  gateway.mlClient.predict = jest.fn(async () => prediction);
  const result = await gateway.predictor.predict(request);
  expect(result).toEqual(prediction);
  expect(metrics.snapshot().ml).toMatchObject({ predictionCount: 1, successCount: 1,
    errorCount: 0, avgHttpMs: 85, avgFastapiMs: 75, avgInferenceMs: 60, avgNetworkResidualMs: 10 });
});

test('known durations are averaged once and unknown server timings use a separate denominator', () => {
  metrics.recordMLPredictionDetail({ totalLatencyMs: 3085, queueWaitMs: 3000, ...prediction.timings, success: true });
  expect(metrics.snapshot().ml).toMatchObject({ predictionCount: 1, avgLatencyMs: 3085,
    avgQueueWaitMs: 3000, avgInferenceMs: 60 });
  metrics.recordMLPredictionDetail({ totalLatencyMs: 15, queueWaitMs: 5, httpMs: 10, success: false });
  expect(metrics.snapshot().ml).toMatchObject({ predictionCount: 2, successCount: 1,
    errorCount: 1, serverTimingCount: 1, avgLatencyMs: 1550, avgQueueWaitMs: 1502.5,
    avgHttpMs: 47.5, avgInferenceMs: 60 });
  metrics.reset();
  expect(metrics.snapshot().ml).toMatchObject({ predictionCount: 0, avgInferenceMs: null, predictionThroughputPerSec: 0 });
});

test('HTTP prediction failure completes the gateway request and balances inFlight', async () => {
  gateway.mlClient.predict = jest.fn(async () => { throw Object.assign(new Error('offline'), {
    code: 'ML_PREDICTION_FAILED', timings: { httpMs: 5 },
  }); });
  const result = await gateway.handle(request);
  expect(result).toMatchObject({ decision: 'REJECT', reason: 'ml_prediction_failed', status: 503 });
  expect(metrics.snapshot()).toMatchObject({ incoming: 1, rejected: 1, inFlight: 0,
    ml: { predictionCount: 1, errorCount: 1 } });
});

test('failure on re-prediction after DELAY also balances inFlight', async () => {
  gateway.mlClient.predict = jest.fn().mockResolvedValueOnce(prediction).mockRejectedValueOnce(
    Object.assign(new Error('offline'), { code: 'ML_PREDICTION_FAILED', timings: { httpMs: 5 } }));
  gateway.engine.decide = jest.fn(async req => {
    await gateway.predictor.predict(req);
    return { decision: 'DELAY', delayMs: 1, predictedCostMs: 30, predictedCloudCostUsd: 0.000001 };
  });
  const result = await gateway.handle(request);
  expect(result.reason).toBe('ml_prediction_failed');
  expect(metrics.snapshot()).toMatchObject({ inFlight: 0, rejected: 1, ml: { predictionCount: 2, errorCount: 1 } });
});

test('service fallback stays usable but is visible in ML error/fallback counters', async () => {
  gateway.mlClient.predict = jest.fn(async () => ({ ...prediction, modelVersion: 'heuristic-v1', fallbackReason: 'model_unavailable' }));
  await gateway.predictor.predict(request);
  expect(metrics.snapshot().ml).toMatchObject({ predictionCount: 1, successCount: 0, errorCount: 1, fallbackCount: 1 });
});

test('comparison experiment reports every failed prediction instead of silently losing requests', async () => {
  jest.spyOn(gateways.predictive.mlClient, 'predict').mockRejectedValue(
    Object.assign(new Error('offline'), { code: 'ML_PREDICTION_FAILED', timings: { httpMs: 1 } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/compare/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'normal', durationSec: 0.15, seed: 42 }),
    });
    const result = await response.json();
    expect(result.totalRequests).toBeGreaterThan(0);
    expect(result.predictive.incoming).toBe(result.totalRequests);
    expect(result.predictive.rejected).toBe(result.totalRequests);
    expect(result.predictive.ml.errorCount).toBe(result.totalRequests);
    expect(result.predictive.inFlight).toBe(0);
    expect(result.predictive.incoming).toBe(result.predictive.processed + result.predictive.rejected);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
