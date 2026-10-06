'use strict';
const PredictionQueue = require('../src/ml/predictionQueue');
const MetricsStore = require('../src/metrics/metricsStore');
const PredictiveGateway = require('../src/gateways/predictiveGateway');
const { DecisionEngine } = require('../src/decision/decisionEngine');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const req = { requestId: 'gate', type: 'db_query', priority: 'normal', precision: 'full', payloadSize: 256, parameters: { iterations: 1200 } };
const prediction = { predictedCostMs: 30, predictedCloudCostUsd: .000001, costTier: 'cheap', confidence: .9, modelVersion: 'test', timings: { httpMs: 70 } };

test('capacity is reserved atomically; normal rejects and high gets larger allowance without queue jumping', async () => {
  const queue = new PredictionQueue(2);
  const d = deferred(); const starts = [];
  const a = queue.run(() => { starts.push('a'); return d.promise; });
  const b = queue.run(() => { starts.push('b'); return d.promise; });
  await expect(queue.run(jest.fn())).rejects.toMatchObject({ reason: 'prediction_wait_limit' });
  const high = queue.run(() => { starts.push('high'); }, { priority: 'high' });
  expect(queue.stats()).toMatchObject({ running: 2, queued: 1 });
  await flush(); expect(starts).toEqual(['a', 'b']);
  d.resolve(); await Promise.all([a, b, high]);
  expect(starts).toEqual(['a', 'b', 'high']);
});

test('hard waiting cap rejects before calling task, even for high priority', async () => {
  const queue = new PredictionQueue(1, { maxWaiting: 1, normalWaitMs: 10000, highWaitMs: 10000 });
  const d = deferred(); const first = queue.run(() => d.promise); const second = queue.run(() => 2);
  const never = jest.fn();
  await expect(queue.run(never, { priority: 'high' })).rejects.toMatchObject({ reason: 'prediction_queue_full' });
  expect(never).not.toHaveBeenCalled(); d.resolve(); await Promise.all([first, second]);
  expect(queue.stats()).toMatchObject({ peakQueued: 1, queued: 0, running: 0 });
});

test('FIFO with mixed priority and failed task releases capacity', async () => {
  const queue = new PredictionQueue(1, { normalWaitMs: 10000, highWaitMs: 10000 });
  const d = deferred(); const starts = [];
  const first = queue.run(() => d.promise);
  const normal = queue.run(() => { starts.push('normal'); throw new Error('failed'); });
  const failure = expect(normal).rejects.toThrow('failed');
  const high = queue.run(() => starts.push('high'), { priority: 'high' });
  d.resolve(); await first; await failure; await high;
  expect(starts).toEqual(['normal', 'high']); expect(queue.stats().running).toBe(0);
});

test('H uses p90, minimum, cold start, latest 100 and rolling 30 seconds', () => {
  let now = 0; const queue = new PredictionQueue(2, { now: () => now });
  for (let i = 0; i < 9; i++) queue.recordHttpSuccess(1);
  expect(queue.estimate().serviceEstimateMs).toBe(100);
  queue.recordHttpSuccess(1); expect(queue.estimate().serviceEstimateMs).toBe(20);
  for (let i = 1; i <= 100; i++) queue.recordHttpSuccess(i);
  expect(queue.estimate()).toMatchObject({ serviceEstimateMs: 90, serviceEstimateSampleCount: 100 });
  now = 30001; expect(queue.estimate()).toMatchObject({ serviceEstimateMs: 100, serviceEstimateSampleCount: 0 });
});

test('active age floors H and wait formula counts full waves', async () => {
  let now = 0; const q = new PredictionQueue(2, { now: () => now });
  const d = deferred(); const a = q.run(() => d.promise); const b = q.run(() => d.promise);
  await flush(); now = 150; expect(q.estimate()).toMatchObject({ serviceEstimateMs: 150, oldestActiveAgeMs: 150, estimatedWaitMs: 150 });
  d.resolve(); await Promise.all([a,b]);
});

test.each([
  ['ALLOW', .001, { concurrent: 0 }],
  ['DOWNGRADE', .000002, { concurrent: 0 }],
  ['DELAY', .001, { concurrent: 8 }],
  ['REJECT', 0, { concurrent: 0 }],
])('successful predictions preserve existing %s behavior', async (decision, remaining, state) => {
  const metrics = new MetricsStore('test'); const gateway = new PredictiveGateway(metrics);
  try {
    gateway.mlClient.predict = jest.fn(async () => prediction);
    gateway.budget.remainingUsd = () => remaining;
    const unchanged = new DecisionEngine({ predict: async () => prediction }, { remainingUsd: () => remaining });
    const expected = await unchanged.decide(req, state);
    expect(expected.decision).toBe(decision);
    expect(await gateway.engine.decide(req, state)).toEqual(expected);
  } finally { clearInterval(metrics._timer); }
});

test('successful execution balances inFlight and records one accuracy sample', async () => {
  const metrics = new MetricsStore('test'); const gateway = new PredictiveGateway(metrics);
  try {
    gateway.mlClient.predict = jest.fn(async () => prediction);
    gateway._executeWithQueue = jest.fn(async () => ({ wallMs: 30, actualCloudCostUsd: .000001, precision: 'full' }));
    expect((await gateway.handle(req)).decision).toBe('ALLOW');
    expect(metrics.snapshot()).toMatchObject({ inFlight: 0, processed: 1, prediction: { samples: 1 }, ml: { successCount: 1, errorCount: 0 } });
  } finally { clearInterval(metrics._timer); }
});

test('queued task expires even if the event loop has not delivered its timer; no task call', async () => {
  let now = 0; const q = new PredictionQueue(1, { now: () => now, normalWaitMs: 100, highWaitMs: 100 });
  const d = deferred(); const a = q.run(() => d.promise); const never = jest.fn(); const queued = q.run(never);
  const expiry = expect(queued).rejects.toMatchObject({ reason: 'prediction_queue_expired' });
  now = 100; d.resolve(); await a; await expiry;
  expect(never).not.toHaveBeenCalled(); expect(q.stats()).toMatchObject({ running: 0, queued: 0 });
});

test('timer expires waiting work while an active call remains stalled', async () => {
  jest.useFakeTimers();
  try {
    const q = new PredictionQueue(1, { now: () => Date.now(), normalWaitMs: 100, highWaitMs: 100 });
    const d = deferred(); const a = q.run(() => d.promise); const task = jest.fn(); const b = q.run(task);
    const expiry = expect(b).rejects.toMatchObject({ reason: 'prediction_queue_expired' });
    await jest.advanceTimersByTimeAsync(100); await expiry;
    expect(task).not.toHaveBeenCalled(); expect(q.stats()).toMatchObject({ queued: 0, running: 1 });
    d.resolve(); await a;
  } finally { jest.useRealTimers(); }
});

test.each(['prediction_wait_limit', 'prediction_queue_full', 'prediction_queue_expired'])('%s balances gateway accounting without HTTP, ML errors or accuracy samples', async reason => {
  const metrics = new MetricsStore('test'); const gateway = new PredictiveGateway(metrics);
  try {
    const now = { value: 0 }; const d = deferred();
    gateway.predictionQueue = new PredictionQueue(1, { maxWaiting: reason === 'prediction_queue_full' ? 0 : 4,
      normalWaitMs: reason === 'prediction_queue_expired' ? 100 : 50, highWaitMs: 100,
      now: () => now.value, onEvent: event => metrics.recordPredictionGate(event) });
    const active = gateway.predictionQueue.run(() => d.promise);
    gateway.mlClient.predict = jest.fn(async () => prediction);
    const resultPromise = gateway.handle(req);
    if (reason === 'prediction_queue_expired') { now.value = 100; d.resolve(); }
    const result = await resultPromise;
    expect(result).toMatchObject({ decision: 'REJECT', reason, status: 503 });
    expect(gateway.mlClient.predict).not.toHaveBeenCalled();
    expect(metrics.snapshot()).toMatchObject({ incoming: 1, rejected: 1, inFlight: 0,
      prediction: { samples: 0 }, ml: { predictionCount: 0, successCount: 0, errorCount: 0 },
      predictionGate: { rejections: 1, rejectionReasons: { [reason]: 1 } } });
    d.resolve(); await active;
  } finally { clearInterval(metrics._timer); }
});

test('successful gateway prediction keeps the original DecisionEngine result and learns H from HTTP only', async () => {
  const metrics = new MetricsStore('test'); const gateway = new PredictiveGateway(metrics);
  try {
    const original = new DecisionEngine({ predict: async () => prediction }, { remainingUsd: () => .001 });
    const expected = await original.decide(req, { cpuPct: 0, queueDepth: 0, concurrent: 0 });
    gateway.mlClient.predict = jest.fn(async () => prediction);
    const outcome = await gateway.engine.decide(req, { cpuPct: 0, queueDepth: 0, concurrent: 0 });
    expect(outcome).toEqual(expected);
    expect(gateway.predictionQueue.samples[0].ms).toBe(70);
    expect(metrics.snapshot()).toMatchObject({ predictionGate: { admissions: 1, attempts: 1, successfulPredictions: 1, mlFailures: 0 } });
  } finally { clearInterval(metrics._timer); }
});

test('a gate rejection during existing DELAY re-prediction keeps its explicit reason', async () => {
  const metrics = new MetricsStore('test'); const gateway = new PredictiveGateway(metrics);
  try {
    gateway.engine.decide = jest.fn().mockResolvedValueOnce({ decision: 'DELAY', delayMs: 1 })
      .mockRejectedValueOnce(new PredictionQueue.PredictionAdmissionError('prediction_wait_limit'));
    const outcome = await gateway.handle(req);
    expect(outcome.reason).toBe('prediction_wait_limit');
    expect(metrics.snapshot()).toMatchObject({ inFlight: 0, ml: { errorCount: 0 }, prediction: { samples: 0 } });
  } finally { clearInterval(metrics._timer); }
});
