'use strict';

/**
 * Deterministic random helpers for the workload simulator.
 * A single seeded PRNG guarantees that the same seed produces the same
 * request stream, run after run -- the basis of a fair comparison.
 */

/** mulberry32: tiny, fast, seedable 32-bit PRNG returning [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential inter-arrival time (ms) for a Poisson process. */
function exponentialIntervalMs(ratePerSec, rng) {
  if (ratePerSec <= 0) return Infinity;
  const u = Math.max(rng(), 1e-12);
  return (-Math.log(u) / ratePerSec) * 1000;
}

/** Pick an integer in [min, max] inclusive. */
function randInt(min, max, rng) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Weighted pick over an object of `{ key: weight }`. */
function weightedPick(weights, rng) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let target = rng() * total;
  for (const [key, weight] of entries) {
    target -= weight;
    if (target <= 0) return key;
  }
  return entries.length ? entries[entries.length - 1][0] : null;
}

/** Deterministic UUID-v4-shaped id derived from the PRNG. */
function uuid(rng) {
  const hex = [];
  for (let i = 0; i < 32; i++) hex.push(Math.floor(rng() * 16).toString(16));
  // force version 4 + variant bits so it looks like a real v4
  hex[12] = '4';
  const variant = ['8', '9', 'a', 'b'][Math.floor(rng() * 4)];
  hex[16] = variant;
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

module.exports = {
  mulberry32,
  exponentialIntervalMs,
  randInt,
  weightedPick,
  uuid,
};
