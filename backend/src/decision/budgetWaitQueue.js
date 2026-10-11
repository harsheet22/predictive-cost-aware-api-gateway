'use strict';
const { performance } = require('perf_hooks');
const { AsyncResource } = require('async_hooks');

/** Bounded FIFO budget waiting. One timer; no ML retries or budget bypass. */
class BudgetWaitQueue {
  constructor({ maxWaiting = 4096, maxWaitMs = 120000, pollMs = 25 } = {}) {
    if (!Number.isInteger(maxWaiting) || maxWaiting < 1 || !Number.isFinite(maxWaitMs) || maxWaitMs < 0 || pollMs < 1) throw new RangeError('invalid budget waiting limits');
    Object.assign(this, { maxWaiting, maxWaitMs, pollMs });
    this.queue = []; this.timer = null; this.peak = 0; this.completed = 0; this.expired = 0;
  }
  run(evaluate) {
    if (this.queue.length >= this.maxWaiting) return Promise.reject(this._error('budget_wait_queue_full'));
    return new Promise((resolve, reject) => {
      this.queue.push({ evaluate: AsyncResource.bind(evaluate), resolve, reject, start: performance.now() });
      this.peak = Math.max(this.peak, this.queue.length);
      if (!this.timer) this._check();
    });
  }
  _error(reason) { const error = new Error(reason); error.code = 'BUDGET_WAIT_REJECTED'; error.reason = reason; return error; }
  _check() {
    this.timer = null;
    const entry = this.queue[0];
    if (!entry) return;
    const waitMs = performance.now() - entry.start;
    let pause = this.pollMs;
    try {
      if (waitMs >= this.maxWaitMs) {
        this.expired++; this.queue.shift(); entry.reject(this._error('budget_wait_expired')); pause = 0;
      } else {
        const decision = entry.evaluate();
        if (decision.decision !== 'REJECT' || decision.reason !== 'budget_exceeded') {
          this.queue.shift(); this.completed++; entry.resolve({ decision, waitMs }); pause = 0;
        }
      }
    } catch (error) { this.queue.shift(); entry.reject(error); pause = 0; }
    // Release one entry per turn so its execution acquires a real slot before
    // evaluating the next request's execution pressure and remaining budget.
    if (this.queue.length) this.timer = setTimeout(() => this._check(), pause);
  }
  stats() { return { queued: this.queue.length, peakQueued: this.peak, completed: this.completed, expired: this.expired, maxWaiting: this.maxWaiting, maxWaitMs: this.maxWaitMs }; }
}
module.exports = BudgetWaitQueue;
