'use strict';
const MLClient = require('../src/ml/mlClient');

const request = { requestId: 'test', type: 'hash_compute', payloadSize: 4096,
  parameters: { iterations: 1234 }, priority: 'normal', precision: 'full' };
const prediction = { predictedCostMs: 30, predictedCloudCostUsd: 0.000002,
  costTier: 'medium', confidence: 0.7, modelVersion: 'rf-test' };
const response = (data = prediction, extra = {}) => ({
  ok: true, status: 200, headers: new Headers({
    'server-timing': 'fastapi;dur=3.5, rf;dur=2.25, worker_queue;dur=0.125',
    ...extra,
  }), json: async () => data,
});
const nativeFetch = global.fetch;
afterEach(() => { global.fetch = nativeFetch; jest.useRealTimers(); });

test('keeps prediction values and separates server durations from HTTP elapsed time', async () => {
  global.fetch = jest.fn(async () => response());
  const client = new MLClient();
  const result = await client.predict(request, { concurrent: 2 });
  expect(result).toMatchObject(prediction);
  expect(result.timings).toMatchObject({ fastapiMs: 3.5, inferenceMs: 2.25, workerQueueMs: 0.125 });
  expect(result.timings.httpMs).toBeGreaterThanOrEqual(0);
  expect(result.timings.networkResidualMs).toBe(Math.max(0, result.timings.httpMs - 3.5));
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ iterations: 1234, systemState: { concurrent: 2 } });
  expect(client.getStats()).toMatchObject({ requestCount: 1, errorCount: 0 });
});

test('missing timing headers remain unknown instead of pretending HTTP time is inference', async () => {
  global.fetch = jest.fn(async () => ({ ...response(), headers: new Headers() }));
  const result = await new MLClient().predict(request);
  expect(result.timings).toMatchObject({ fastapiMs: null, inferenceMs: null, networkResidualMs: null });
});

test.each(['transport', 'http', 'malformed'])('%s failure is typed, timed, and counted once', async kind => {
  global.fetch = jest.fn(async () => {
    if (kind === 'transport') throw new Error('offline');
    if (kind === 'http') return { ...response(), ok: false, status: 500, text: async () => 'broken' };
    return response({ ...prediction, predictedCostMs: 'invalid' });
  });
  const client = new MLClient();
  await expect(client.predict(request)).rejects.toMatchObject({ code: 'ML_PREDICTION_FAILED', timings: { httpMs: expect.any(Number) } });
  expect(client.getStats()).toMatchObject({ requestCount: 1, errorCount: 1 });
});

test('timeout remains active while reading the response body and is cleaned up', async () => {
  jest.useFakeTimers();
  global.fetch = jest.fn(async (_url, options) => ({ ...response(), json: () => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
  }) }));
  const client = new MLClient();
  client.timeout = 10;
  const result = client.predict(request);
  const failure = expect(result).rejects.toMatchObject({ code: 'ML_PREDICTION_FAILED' });
  await jest.advanceTimersByTimeAsync(11);
  await failure;
  expect(jest.getTimerCount()).toBe(0);
  expect(client.getStats().errorCount).toBe(1);
});

test('existing service heuristic fallback is explicit and counted as an ML error', async () => {
  global.fetch = jest.fn(async () => response({ ...prediction, modelVersion: 'heuristic-v1' }, {
    'x-prediction-fallback': 'inference_failed',
  }));
  const client = new MLClient();
  const result = await client.predict(request);
  expect(result.fallbackReason).toBe('inference_failed');
  expect(client.getStats()).toMatchObject({ requestCount: 1, errorCount: 1, fallbackCount: 1 });
});
