'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const { performance } = require('perf_hooks');
function observer() {
  const context = new AsyncLocalStorage();
  const rows = [];
  const byId = new Map();
  const queuePeaks = { executionWaiting: 0, executionActive: 0, budgetWaiting: 0 };
  const restores = [];
  function patch(target, key, wrap) {
    const original = target[key]; target[key] = wrap(original); restores.push(() => { target[key] = original; });
  }
  function settled(promise, success, failure = () => {}) {
    // Attach observers, but return the original Promise to preserve callers' contract.
    promise.then(success, failure); return promise;
  }
  function installExecutor() {
    const executor = require('../../src/workload/executor');
    patch(executor, 'execute', original => function(request, ...args) {
      const row = byId.get(request.requestId) || context.getStore();
      if (row) row.executionStartMs = performance.now();
      return settled(original.call(this, request, ...args), value => {
        if (row) { row.execution = value; row.executionEndMs = performance.now(); }
      }, error => { if (row) row.executionError = error.message; });
    });
  }
  function attach(gateway) {
    if (gateway.engine) patch(gateway.engine, 'decidePrediction', original => function(...args) {
      const decision = original.apply(this, args);
      const row = byId.get(args[0].requestId) || context.getStore();
      if (row) (row.policyEvaluations ||= []).push({ atMs: performance.now(), state: { ...args[1] }, ...decision });
      return decision;
    });
    if (gateway.predictionQueue) {
      const queue = gateway.predictionQueue;
      patch(queue, 'onEvent', original => event => {
        original(event);
        const row = byId.get(event.requestId);
        if (!row) return;
        if (event.kind === 'admission') row.predictionAdmission = { ...event, atMs: performance.now() };
        if (event.kind === 'start') row.predictionStart = { ...event, atMs: performance.now() };
        if (event.kind === 'rejection') row.predictionRejection = { ...event, atMs: performance.now() };
      });
      patch(gateway.mlClient, 'predict', original => function(...args) {
        const row = byId.get(args[0].requestId) || context.getStore();
        if (row) row.httpStartMs = performance.now();
        return settled(original.apply(this, args), value => {
          if (row) { row.prediction = value; row.httpEndMs = performance.now(); }
        }, error => { if (row) { row.mlFailure = { message: error.message, timings: error.timings }; row.httpEndMs = performance.now(); } });
      });
      patch(gateway.budgetWaitQueue, 'run', original => function(...args) {
        const row = context.getStore(), start = performance.now();
        const promise = original.apply(this, args);
        queuePeaks.budgetWaiting = Math.max(queuePeaks.budgetWaiting, this.queue.length);
        return settled(promise, () => { if (row) row.budgetWaitMs = (row.budgetWaitMs || 0) + performance.now() - start; },
          error => { if (row) { row.budgetWaitMs = (row.budgetWaitMs || 0) + performance.now() - start; row.budgetWaitError = error.reason; } });
      });
    }
    if (gateway.rate?.run) patch(gateway.rate, 'run', original => function(task) {
      const row = context.getStore(); if (row) row.executionQueuedMs = performance.now();
      const wrapped = () => {
        queuePeaks.executionActive = Math.max(queuePeaks.executionActive, this.active);
        return task();
      };
      const promise = original.call(this, wrapped);
      queuePeaks.executionWaiting = Math.max(queuePeaks.executionWaiting, this.queue.length);
      return promise;
    });
    if (gateway.concurrency) patch(gateway.concurrency, 'tryAcquire', original => function(...args) {
      const answer = original.apply(this, args);
      queuePeaks.executionActive = Math.max(queuePeaks.executionActive, this.active); return answer;
    });
  }
  function handle(gateway, request, metadata) {
    const row = { ...metadata, requestId: request.requestId, request, gatewayEntryMs: performance.now(), serverEntryEpochMs: Date.now() };
    rows.push(row);
    byId.set(request.requestId, row);
    return context.run(row, () => settled(gateway.handle(request), outcome => { row.outcome = outcome; row.gatewayEndMs = performance.now(); },
      error => { row.handlerError = error.message; row.gatewayEndMs = performance.now(); }));
  }
  return { rows, queuePeaks, installExecutor, attach, handle, restore: () => restores.reverse().forEach(fn => fn()) };
}
module.exports = { observer };
