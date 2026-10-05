'use strict';

/**
 * Admission-control primitives shared by the gateways.
 *
 * TokenBucket            - traditional request-count / rate limiting.
 * ConcurrencyGuard       - a fixed cap on in-flight work (bulkhead).
 * QueuedConcurrencyGuard - bounded waiting room; used by the predictive gateway.
 */

class TokenBucket {
  constructor({ capacity, refillPerSec, enabled = true }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.enabled = enabled;
    this.tokens = capacity;
    this.lastRefill = Date.now();
    this.granted = 0;
    this.denied = 0;
  }

  _refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefill = now;
  }

  /** Non-blocking attempt to take `count` tokens. */
  tryTake(count = 1) {
    if (!this.enabled) return true;
    this._refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      this.granted++;
      return true;
    }
    this.denied++;
    return false;
  }

  stats() {
    return { tokens: Math.floor(this.tokens), granted: this.granted, denied: this.denied };
  }
}

/** A simple, NON-queueing concurrency cap (acquire returns false when full). */
class ConcurrencyGuard {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
  }

  tryAcquire() {
    if (this.active >= this.maxConcurrent) return false;
    this.active++;
    return true;
  }

  release() {
    if (this.active > 0) this.active--;
  }

  stats() {
    return { active: this.active, maxConcurrent: this.maxConcurrent };
  }
}

/**
 * Bounded concurrency + a bounded FIFO queue.
 *
 * run(fn) admits immediately when a slot is free, queues while the waiting room
 * has space, and otherwise rejects with a ShedError. This is the mechanism that
 * lets the predictive gateway stay responsive: it never lets unbounded work
 * pile up on the event loop.
 */
class ShedError extends Error {
  constructor(message = 'load shed') {
    super(message);
    this.name = 'ShedError';
    this.code = 'SHED';
  }
}

class QueuedConcurrencyGuard {
  constructor({ maxConcurrent, maxQueue }) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
    this.shed = 0;
    this.admitted = 0;
    this.peakQueue = 0;
  }

  stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      maxQueue: this.maxQueue,
      shed: this.shed,
      admitted: this.admitted,
      peakQueue: this.peakQueue,
    };
  }

  /** @returns {Promise<any>} resolves with fn() result, or rejects with ShedError */
  run(fn) {
    return new Promise((resolve, reject) => {
      const task = () => {
        this.active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this._drain();
          });
      };

      if (this.active < this.maxConcurrent) {
        this.admitted++;
        task();
      } else if (this.queue.length < this.maxQueue) {
        this.queue.push(task);
        if (this.queue.length > this.peakQueue) this.peakQueue = this.queue.length;
      } else {
        this.shed++;
        reject(new ShedError('queue full'));
      }
    });
  }

  _drain() {
    if (this.active < this.maxConcurrent && this.queue.length) {
      const next = this.queue.shift();
      this.admitted++;
      next();
    }
  }
}

module.exports = { TokenBucket, ConcurrencyGuard, QueuedConcurrencyGuard, ShedError };
