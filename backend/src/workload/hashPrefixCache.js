'use strict';
const jobs = require('./jobs');
const config = require('../config');

/** Reuse only deterministic CPU prefixes. Never cache a response or skip I/O. */
class HashPrefixCache {
  constructor({ maxSeeds = 128, maxCheckpointsPerSeed = 64, checkpointIterations = 512 } = {}) {
    for (const value of [maxSeeds, maxCheckpointsPerSeed, checkpointIterations]) {
      if (!Number.isInteger(value) || value < 1) throw new RangeError('invalid hash prefix cache capacity');
    }
    this.maxSeeds = maxSeeds;
    this.maxCheckpointsPerSeed = maxCheckpointsPerSeed;
    this.checkpointIterations = checkpointIterations;
    this.seeds = new Map();
    this.calls = 0; this.requested = 0; this.computed = 0; this.reused = 0;
  }

  async run(iterations, seed) {
    if (!Number.isInteger(iterations) || iterations < 0) throw new RangeError('invalid hash iteration count');
    seed = String(seed);
    let checkpoints = this.seeds.get(seed);
    if (!checkpoints) checkpoints = new Map();
    this.seeds.delete(seed); this.seeds.set(seed, checkpoints);
    while (this.seeds.size > this.maxSeeds) this.seeds.delete(this.seeds.keys().next().value);
    let done = 0; let digest = seed;
    for (const [position, value] of checkpoints) {
      if (position <= iterations && position > done) { done = position; digest = value; }
    }
    const reused = done;
    let sinceYield = 0;
    while (done < iterations) {
      const end = Math.min(iterations, (Math.floor(done / this.checkpointIterations) + 1) * this.checkpointIterations);
      digest = jobs.hashRange(digest, done, end - done);
      sinceYield += end - done;
      done = end;
      checkpoints.set(done, digest);
      while (checkpoints.size > this.maxCheckpointsPerSeed) checkpoints.delete(checkpoints.keys().next().value);
      if (config.executor.syncIterationCap && sinceYield >= config.executor.syncIterationCap && done < iterations) {
        sinceYield = 0;
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    this.calls++; this.requested += iterations; this.computed += iterations - reused; this.reused += reused;
    return { digest, computed: iterations - reused, reused };
  }

  stats() {
    return { seeds: this.seeds.size, maxSeeds: this.maxSeeds, maxCheckpointsPerSeed: this.maxCheckpointsPerSeed,
      calls: this.calls, requestedIterations: this.requested, computedIterations: this.computed,
      reusedIterations: this.reused, reuseFraction: this.requested ? this.reused / this.requested : 0 };
  }
}
module.exports = HashPrefixCache;
