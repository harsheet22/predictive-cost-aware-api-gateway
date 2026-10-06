'use strict';

/**
 * Bounded concurrency queue for ML predictions.
 * Starts tasks FIFO, with at most N active predictions. Completion order may
 * differ; each caller still receives the result of its own task.
 */

class PredictionQueue {
  constructor(maxConcurrency = 4) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError('prediction concurrency must be a positive integer');
    }
    this.maxConcurrency = maxConcurrency;
    this.running = 0;
    this.queue = [];
    this.peakQueued = 0;
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
      this.peakQueued = Math.max(this.peakQueued, this.queue.length);
    });
  }

  _drain() {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const { task, resolve, reject } = this.queue.shift();
      this.running++;
      
      Promise.resolve()
        .then(() => task())
        .then(value => {
          this.running--;
          this._drain();
          resolve(value);
        }, error => {
          this.running--;
          this._drain();
          reject(error);
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
      peakQueued: this.peakQueued,
    };
  }
}

module.exports = PredictionQueue;
