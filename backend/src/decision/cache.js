'use strict';

/**
 * Simple in-memory LRU cache with TTL.
 * Used by the predictive gateway for the DOWNGRADE path:
 * when a request is downgraded, we serve a cached "reduced" result if available.
 */
const config = require('../config');

class LRUCache {
  constructor({ maxEntries, ttlMs }) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { value, expiresAt }
    this.order = [];      // keys in LRU order (oldest first)
  }

  _evict() {
    while (this.order.length > this.maxEntries) {
      const oldest = this.order.shift();
      this.map.delete(oldest);
    }
  }

  _expire(key) {
    const entry = this.map.get(key);
    if (entry && entry.expiresAt < Date.now()) {
      this.map.delete(key);
      const idx = this.order.indexOf(key);
      if (idx >= 0) this.order.splice(idx, 1);
      return true;
    }
    return false;
  }

  _touch(key) {
    const idx = this.order.indexOf(key);
    if (idx >= 0) {
      this.order.splice(idx, 1);
      this.order.push(key);
    }
  }

  get(key) {
    if (this._expire(key)) return undefined;
    const entry = this.map.get(key);
    if (entry) {
      this._touch(key);
      return entry.value;
    }
    return undefined;
  }

  set(key, value) {
    const expiresAt = Date.now() + this.ttlMs;
    if (this.map.has(key)) {
      this.map.set(key, { value, expiresAt });
      this._touch(key);
    } else {
      this.map.set(key, { value, expiresAt });
      this.order.push(key);
      this._evict();
    }
  }

  has(key) {
    return !this._expire(key) && this.map.has(key);
  }

  stats() {
    return { size: this.map.size, maxEntries: this.maxEntries, ttlMs: this.ttlMs };
  }
}

module.exports = LRUCache;