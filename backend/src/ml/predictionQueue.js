'use strict';

/**
 * Bounded concurrency queue for ML predictions.
 * Allows up to N concurrent ML predictions while preserving request order.
 */

class PredictionQueue {
  constructor(maxConcurrency = 4) {
    this.maxConcurrency = maxConcurrency;
    this.running = 0;
    this.queue = [];
  }

  /**
   * Run a task with bounded concurrency.
   * @param {Function} task - Async function that returns a promise
   * @returns {Promise<any>} Result of the task
   */
  async run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const { task, resolve, reject } = this.queue.shift();
      this.running++;
      
      Promise.resolve()
        .then(() => task())
        .then(resolve, reject)
        .finally(() => {
          this.running--;
          this._drain();
        });
    }
  }

  /**
   * Get current queue stats.
   * @returns {object}
   */
  stats() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrency: this.maxConcurrency,
    };
  }
}

module.exports = PredictionQueue;