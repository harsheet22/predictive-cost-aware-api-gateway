'use strict';
const { performance } = require('perf_hooks');
class PredictionAdmissionError extends Error {
  constructor(reason) { super(reason); this.code = 'PREDICTION_ADMISSION_REJECTED'; this.reason = reason; }
}
/** Atomic admission and bounded FIFO waiting, independent of the cost policy. */
class PredictionQueue {
  constructor(maxConcurrency = 4, options = {}) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new RangeError('prediction concurrency must be a positive integer');
    this.maxConcurrency = maxConcurrency;
    this.maxWaiting = options.maxWaiting ?? 4;
    this.normalWaitMs = options.normalWaitMs ?? 50;
    this.highWaitMs = options.highWaitMs ?? 100;
    if (!Number.isInteger(this.maxWaiting) || this.maxWaiting < 0 || !Number.isFinite(this.normalWaitMs) || this.normalWaitMs < 0 || !Number.isFinite(this.highWaitMs) || this.highWaitMs < this.normalWaitMs) throw new RangeError('invalid prediction admission limits');
    this.now = options.now || (() => performance.now());
    this.onEvent = options.onEvent || (() => {});
    this.running = 0; this.queue = []; this.active = new Set(); this.samples = []; this.peakQueued = 0;
  }
  recordHttpSuccess(httpMs) {
    if (!Number.isFinite(httpMs) || httpMs < 0) return;
    this.samples.push({ at: this.now(), ms: httpMs });
    this.samples = this.samples.filter(s => s.at >= this.now() - 30000).slice(-100);
  }
  estimate() {
    const now = this.now();
    this.samples = this.samples.filter(s => s.at >= now - 30000);
    const sorted = this.samples.map(s => s.ms).sort((a, b) => a - b);
    const base = sorted.length < 10 ? 100 : Math.max(20, sorted[Math.ceil(sorted.length * .9) - 1]);
    const oldestActiveAgeMs = Math.max(0, ...Array.from(this.active, entry => now - entry.startedAt));
    const serviceEstimateMs = Math.max(base, oldestActiveAgeMs);
    return { serviceEstimateMs, oldestActiveAgeMs, serviceEstimateSampleCount: sorted.length,
      estimatedWaitMs: Math.max(0, Math.ceil((this.running + this.queue.length + 1) / this.maxConcurrency) - 1) * serviceEstimateMs };
  }
  _event(kind, detail = {}) { this.onEvent({ kind, ...detail, ...this.stats() }); }
  run(task, { priority = 'normal', requestId } = {}) {
    this._expire();
    const estimate = this.estimate();
    const waitLimitMs = priority === 'high' ? this.highWaitMs : this.normalWaitMs;
    const mustWait = this.running >= this.maxConcurrency || this.queue.length > 0;
    const reason = mustWait && this.queue.length >= this.maxWaiting ? 'prediction_queue_full'
      : estimate.estimatedWaitMs > waitLimitMs ? 'prediction_wait_limit' : null;
    const detail = { requestId, priority, waitLimitMs, ...estimate };
    if (reason) {
      this._event('rejection', { ...detail, reason });
      return Promise.reject(new PredictionAdmissionError(reason));
    }
    // No await between checking state and reserving/enqueueing the task.
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, submittedAt: this.now(), deadline: this.now() + waitLimitMs, detail, waiting: mustWait };
      this.queue.push(entry);
      if (mustWait) entry.timer = setTimeout(() => { this._expire(); this._drain(); }, waitLimitMs);
      this.peakQueued = Math.max(this.peakQueued, mustWait ? this.queue.length : 0);
      this._event('admission', detail);
      this._drain();
    });
  }
  _expire() {
    const now = this.now();
    const expired = this.queue.filter(e => e.waiting && now >= e.deadline);
    this.queue = this.queue.filter(e => !e.waiting || now < e.deadline);
    for (const entry of expired) {
      clearTimeout(entry.timer);
      this._event('rejection', { ...entry.detail, reason: 'prediction_queue_expired', actualWaitMs: now - entry.submittedAt });
      entry.reject(new PredictionAdmissionError('prediction_queue_expired'));
    }
  }
  _drain() {
    this._expire();
    while (this.running < this.maxConcurrency && this.queue.length) {
      const entry = this.queue.shift();
      clearTimeout(entry.timer);
      this.running++;
      entry.startedAt = this.now(); this.active.add(entry);
      Promise.resolve().then(() => {
        // Recheck immediately before HTTP submission, even if scheduling was late.
        entry.startedAt = this.now();
        if (entry.waiting && entry.startedAt >= entry.deadline) {
          this._event('rejection', { ...entry.detail, reason: 'prediction_queue_expired', actualWaitMs: entry.startedAt - entry.submittedAt });
          throw new PredictionAdmissionError('prediction_queue_expired');
        }
        this._event('start', { ...entry.detail, actualWaitMs: entry.startedAt - entry.submittedAt });
        return entry.task();
      }).then(value => { this._complete(entry); entry.resolve(value); }, error => { this._complete(entry); entry.reject(error); });
    }
    this._event('state');
  }
  _complete(entry) { this.running--; this.active.delete(entry); this._drain(); }
  stats() {
    return { running: this.running, queued: this.queue.length, maxConcurrency: this.maxConcurrency,
      maxWaiting: this.maxWaiting, occupancy: this.maxWaiting ? this.queue.length / this.maxWaiting : 0, peakQueued: this.peakQueued };
  }
}
module.exports = PredictionQueue;
module.exports.PredictionAdmissionError = PredictionAdmissionError;
