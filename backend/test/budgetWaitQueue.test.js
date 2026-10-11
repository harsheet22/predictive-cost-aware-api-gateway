'use strict';
const BudgetWaitQueue = require('../src/decision/budgetWaitQueue');
const PredictiveGateway = require('../src/gateways/predictiveGateway');
const MetricsStore = require('../src/metrics/metricsStore');
const { performance } = require('perf_hooks');
const decision = { decision: 'ALLOW', reason: 'cheap_and_budget_ok', predictedCostMs: 30,
  predictedCloudCostUsd: .000001, confidence: .9, costTier: 'cheap', modelVersion: 'test' };
const blocked = { ...decision, decision: 'REJECT', reason: 'budget_exceeded' };

beforeEach(() => { jest.useFakeTimers(); jest.spyOn(performance, 'now').mockImplementation(() => Date.now()); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('budget waiting is bounded FIFO and reevaluates fresh state', async () => {
  const queue = new BudgetWaitQueue({ maxWaiting: 2, maxWaitMs: 1000 });
  let ready = false; const order = [];
  const a = queue.run(() => { if (ready) order.push('a'); return ready ? decision : blocked; });
  const b = queue.run(() => { order.push('b'); return decision; });
  await expect(queue.run(() => decision)).rejects.toMatchObject({ reason: 'budget_wait_queue_full' });
  expect(order).toEqual([]); ready = true;
  await jest.advanceTimersByTimeAsync(30);
  expect((await a).decision).toEqual(decision); await b;
  expect(order).toEqual(['a', 'b']); expect(queue.stats().queued).toBe(0);
});

test('budget expiry releases waiting accounting without evaluating forever', async () => {
  const queue = new BudgetWaitQueue({ maxWaiting: 1, maxWaitMs: 50 });
  const pending = expect(queue.run(() => blocked)).rejects.toMatchObject({ reason: 'budget_wait_expired' });
  await jest.advanceTimersByTimeAsync(50); await pending;
  expect(queue.stats()).toMatchObject({ queued: 0, expired: 1 });
});

test('failed evaluation releases the entry and the next request', async () => {
  const queue = new BudgetWaitQueue();
  await expect(queue.run(() => { throw Error('failed'); })).rejects.toThrow('failed');
  expect((await queue.run(() => decision)).decision).toEqual(decision);
  expect(queue.stats().queued).toBe(0);
});

test('gateway waits for the original rolling budget with one prediction and balanced metrics', async () => {
  const metrics = new MetricsStore('budget-test'); const gateway = new PredictiveGateway(metrics);
  gateway.mlClient.predict = jest.fn(async () => ({ ...decision, timings: { httpMs: 1 } }));
  gateway.budget.recordCost(.001);
  try {
    const request = { requestId: 'waiting', type: 'hash_compute', priority: 'normal', precision: 'full', payloadSize: 256, parameters: { itemId: 1 } };
    const pending = gateway.handle(request);
    await jest.advanceTimersByTimeAsync(10);
    expect(gateway.budgetWaitQueue.stats().queued).toBe(1);
    expect(gateway.budget.remainingUsd()).toBe(0);
    await jest.advanceTimersByTimeAsync(10100);
    const result = await pending;
    expect(result).toMatchObject({ status: 200, decision: 'DELAY', precision: 'full', reason: 'budget_or_execution_wait' });
    expect(result.delayMs).toBeGreaterThanOrEqual(10000);
    expect(gateway.mlClient.predict).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot()).toMatchObject({ incoming: 1, processed: 1, rejected: 0, delayed: 1, inFlight: 0, prediction: { samples: 1 }, ml: { successCount: 1, errorCount: 0 } });
  } finally { clearInterval(metrics._timer); }
});

test('budget waiting expiry is explicit, balances inFlight and is not an ML error or accuracy sample', async () => {
  const metrics = new MetricsStore('budget-expiry'); const gateway = new PredictiveGateway(metrics);
  gateway.budgetWaitQueue = new BudgetWaitQueue({ maxWaitMs: 50 });
  gateway.mlClient.predict = jest.fn(async () => ({ ...decision, timings: { httpMs: 1 } }));
  gateway.budget.recordCost(.001);
  try {
    const pending = gateway.handle({ requestId: 'expired', type: 'hash_compute', priority: 'normal', precision: 'full', payloadSize: 256, parameters: { itemId: 1 } });
    await jest.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ status: 503, decision: 'REJECT', reason: 'budget_wait_expired' });
    expect(gateway.mlClient.predict).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot()).toMatchObject({ incoming: 1, processed: 0, rejected: 1, inFlight: 0, prediction: { samples: 0 }, ml: { successCount: 1, errorCount: 0 } });
  } finally { clearInterval(metrics._timer); }
});

test('budget consumed during execution delay waits again instead of rejecting or re-predicting', async () => {
  const metrics = new MetricsStore('budget-race'); const gateway = new PredictiveGateway(metrics);
  gateway.mlClient.predict = jest.fn(async () => ({ ...decision, timings: { httpMs: 1 } }));
  gateway.engine.decide = jest.fn(async request => {
    const prediction = await gateway.predictor.predict(request);
    gateway.budget.recordCost(.001); // other executions consumed budget meanwhile
    return { ...prediction, decision: 'DELAY', reason: 'cheap_concurrency_full', delayMs: 1 };
  });
  try {
    const pending = gateway.handle({ requestId: 'race', type: 'hash_compute', priority: 'normal', precision: 'full', payloadSize: 256, parameters: { itemId: 1 } });
    await jest.advanceTimersByTimeAsync(20);
    expect(gateway.budgetWaitQueue.stats().queued).toBe(1);
    await jest.advanceTimersByTimeAsync(10100);
    expect(await pending).toMatchObject({ status: 200, decision: 'DELAY' });
    expect(gateway.mlClient.predict).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot()).toMatchObject({ processed: 1, rejected: 0, inFlight: 0, ml: { successCount: 1, errorCount: 0 } });
  } finally { clearInterval(metrics._timer); }
});
