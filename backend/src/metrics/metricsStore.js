'use strict';

/**
 * Per-gateway metrics store.
 *
 * Extends the simple throughput/latency collector with the fields the project
 * cares about: outcome counts (processed/delayed/downgraded/rejected),
 * estimated cloud cost, cost per success, SLA compliance, and online
 * predicted-vs-actual accuracy (MAE/RMSE/MAPE/R2).
 */
const config = require('../config');

const BUCKETS = config.metrics.latencyBucketsMs;
const BUCKET_COUNT = BUCKETS.length + 1;
const WINDOW_MS = 5000;

class MetricsStore {
  constructor(name) {
    this.name = name;
    this.startedAt = Date.now();
    this.reset();
    this._timer = setInterval(() => this._sample(), config.metrics.sampleIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  reset() {
    // traffic
    this.incoming = 0;
    this.inFlight = 0;
    this.processed = 0;
    this.rejected = 0;
    this.rateLimited = 0;
    this.shed = 0;
    this.errors = 0;
    this.slaMet = 0;

    // decisions
    this.allowed = 0;
    this.delayed = 0;
    this.downgraded = 0;

    // cache
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // latency histogram
    this.latencyCount = 0;
    this.latencySum = 0;
    this.latencyMax = 0;
    this.buckets = new Array(BUCKET_COUNT).fill(0);

    // cost
    this.totalActualCostUsd = 0;
    this.totalPredictedCostUsd = 0;

    // prediction accuracy (online regression error)
    this.pred = { n: 0, sumAbs: 0, sumSq: 0, sumPct: 0, sumY: 0, sumY2: 0 };

    // ML prediction metrics
    this.mlPredictionCount = 0;
    this.mlPredictionErrors = 0;
    this.mlPredictionLatencySum = 0;
    
    // Detailed ML latency breakdown
    this.mlInferenceLatencySum = 0;
    this.mlQueueWaitSum = 0;
    this.mlTotalLatencySum = 0;

    // concurrency tracking
    this._concurrencySum = 0;
    this._concurrencySamples = 0;
    this.maxConcurrency = 0;

    // queue state (set externally by a queued gateway)
    this.queueDepth = 0;
    this.queueMax = 0;

    // throughput window + resources
    this.rps = 0;
    this.cpuPercent = 0;
    this.rssBytes = process.memoryUsage().rss;
    this._recent = [];

    // Experiment throughput (calculated at experiment end, not sliding window)
    this._experimentStartTime = null;
    this._experimentEndTime = null;
    this.experimentThroughput = {
      incomingPerSec: 0,
      processedPerSec: 0,
      rejectedPerSec: 0,
      delayedPerSec: 0,
      downgradedPerSec: 0,
    };

    this._lastCpu = process.cpuUsage();
    this._lastCpuAt = process.hrtime.bigint();
    this.startedAt = Date.now();
  }

  /** A request has arrived and is now in flight. */
  begin() {
    this.incoming++;
    this.inFlight++;
    if (this.inFlight > this.maxConcurrency) this.maxConcurrency = this.inFlight;
    this._concurrencySum += this.inFlight;
    this._concurrencySamples++;
  }

  /** Mark the start of an experiment run. */
  markExperimentStart(durationSec) {
    this._experimentStartTime = Date.now();
    this._experimentEndTime = null;
    this._experimentDurationSec = durationSec;
  }

  /** Mark the end of an experiment run and calculate throughput. */
  markExperimentEnd() {
    this._experimentEndTime = Date.now();
    if (this._experimentStartTime && this._experimentDurationSec) {
      const durationSec = this._experimentDurationSec;
      this.experimentThroughput = {
        incomingPerSec: Number((this.incoming / durationSec).toFixed(1)),
        processedPerSec: Number((this.processed / durationSec).toFixed(1)),
        rejectedPerSec: Number((this.rejected / durationSec).toFixed(1)),
        delayedPerSec: Number((this.delayed / durationSec).toFixed(1)),
        downgradedPerSec: Number((this.downgraded / durationSec).toFixed(1)),
      };
    }
  }

  recordCacheHit() { this.cacheHits++; }
  recordCacheMiss() { this.cacheMisses++; }
  setQueue(depth, max) { this.queueDepth = depth; this.queueMax = max; }

  /** Record ML prediction metrics (simple). */
  recordMLPrediction(latencyMs, success) {
    this.mlPredictionCount++;
    this.mlPredictionLatencySum += latencyMs;
    if (!success) this.mlPredictionErrors++;
  }

  /** Record detailed ML prediction metrics with latency breakdown. */
  recordMLPredictionDetail(detail) {
    this.mlPredictionCount++;
    this.mlTotalLatencySum += detail.totalLatencyMs || 0;
    this.mlInferenceLatencySum += detail.mlInferenceMs || 0;
    this.mlQueueWaitSum += detail.queueWaitMs || 0;
    if (!detail.success) this.mlPredictionErrors++;
  }

  /**
   * Record the final outcome of one request.
   * @param {object} o
   * @param {string} o.decision       ALLOW | DELAY | DOWNGRADE | REJECT
   * @param {number} o.status
   * @param {number} o.latencyMs
   * @param {boolean} o.slaMet
   * @param {number} [o.actualCostMs]
   * @param {number} [o.actualCostUsd]
   * @param {number} [o.predictedCostMs]
   * @param {number} [o.predictedCostUsd]
   */
  record(o) {
    this.inFlight = Math.max(0, this.inFlight - 1);

    if (o.decision === 'REJECT') this.rejected++;
    if (o.status === 200) this.processed++;
    if (o.status === 429) this.rateLimited++;
    if (o.status === 503) this.shed++;
    if (o.status >= 500 && o.status !== 503) this.errors++;
    if (o.slaMet) this.slaMet++;

    if (o.decision === 'ALLOW') this.allowed++;
    else if (o.decision === 'DELAY') this.delayed++;
    else if (o.decision === 'DOWNGRADE') this.downgraded++;

    // latency histogram (only for responses, i.e. everything)
    this.latencyCount++;
    this.latencySum += o.latencyMs;
    if (o.latencyMs > this.latencyMax) this.latencyMax = o.latencyMs;
    let index = BUCKETS.findIndex((edge) => o.latencyMs <= edge);
    if (index === -1) index = BUCKETS.length;
    this.buckets[index]++;
    this._recent.push(Date.now());

    // cost
    if (o.actualCostUsd) this.totalActualCostUsd += o.actualCostUsd;
    if (o.predictedCostUsd) this.totalPredictedCostUsd += o.predictedCostUsd;

    // prediction accuracy (only when we actually executed and had a prediction)
    if (o.actualCostMs != null && o.predictedCostMs != null && o.status === 200) {
      const error = o.predictedCostMs - o.actualCostMs;
      this.pred.n++;
      this.pred.sumAbs += Math.abs(error);
      this.pred.sumSq += error * error;
      if (o.actualCostMs > 0) this.pred.sumPct += Math.abs(error) / o.actualCostMs;
      this.pred.sumY += o.actualCostMs;
      this.pred.sumY2 += o.actualCostMs * o.actualCostMs;
    }
  }

  _percentile(p) {
    if (this.latencyCount === 0) return 0;
    const target = p * this.latencyCount;
    let cumulative = 0;
    for (let i = 0; i < BUCKET_COUNT; i++) {
      cumulative += this.buckets[i];
      if (cumulative >= target) {
        return i < BUCKETS.length ? BUCKETS[i] : Math.round(this.latencyMax);
      }
    }
    return Math.round(this.latencyMax);
  }

  _sample() {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    while (this._recent.length && this._recent[0] < cutoff) this._recent.shift();
    const uptimeSec = Math.max((now - this.startedAt) / 1000, 0.001);
    const windowSec = Math.min(WINDOW_MS / 1000, uptimeSec);
    this.rps = Number((this._recent.length / windowSec).toFixed(1));

    const cpuNow = process.hrtime.bigint();
    const usage = process.cpuUsage(this._lastCpu);
    const elapsedUs = Number(cpuNow - this._lastCpuAt) / 1000 || 1;
    this.cpuPercent = Number((((usage.user + usage.system) / elapsedUs) * 100).toFixed(1));
    this._lastCpu = process.cpuUsage();
    this._lastCpuAt = cpuNow;

    this.rssBytes = process.memoryUsage().rss;
  }

  _predictionStats() {
    const p = this.pred;
    if (!p.n) return { samples: 0, maeMs: 0, rmseMs: 0, mape: 0, r2: 0 };
    const meanY = p.sumY / p.n;
    const ssTot = p.sumY2 - p.n * meanY * meanY;
    const r2 = ssTot > 0 ? 1 - p.sumSq / ssTot : 0;
    return {
      samples: p.n,
      maeMs: Number((p.sumAbs / p.n).toFixed(3)),
      rmseMs: Number(Math.sqrt(p.sumSq / p.n).toFixed(3)),
      mape: Number((p.sumPct / p.n).toFixed(4)),
      r2: Number(r2.toFixed(4)),
    };
  }

  snapshot() {
    const totalRequests = this.cacheHits + this.cacheMisses;
    return {
      name: this.name,
      uptimeMs: Date.now() - this.startedAt,
      incoming: this.incoming,
      processed: this.processed,
      rejected: this.rejected,
      delayed: this.delayed,
      downgraded: this.downgraded,
      allowed: this.allowed,
      rateLimited: this.rateLimited,
      shed: this.shed,
      errors: this.errors,
      slaMet: this.slaMet,
      inFlight: this.inFlight,
      rps: this.rps,
      // Experiment throughput (calculated at experiment end)
      experimentThroughput: this.experimentThroughput,
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRatio: totalRequests ? Number((this.cacheHits / totalRequests).toFixed(3)) : 0,
      },
      latency: {
        count: this.latencyCount,
        avg: this.latencyCount ? Number((this.latencySum / this.latencyCount).toFixed(2)) : 0,
        p50: this._percentile(0.5),
        p90: this._percentile(0.9),
        p95: this._percentile(0.95),
        p99: this._percentile(0.99),
        max: Math.round(this.latencyMax),
      },
      utilization: {
        cpuPct: this.cpuPercent,
        rssBytes: this.rssBytes,
        avgConcurrency: this._concurrencySamples
          ? Number((this._concurrencySum / this._concurrencySamples).toFixed(2))
          : 0,
        maxConcurrency: this.maxConcurrency,
        queueDepth: this.queueDepth,
        queueMax: this.queueMax,
      },
      cost: {
        estimatedCloudCostUsd: Number(this.totalActualCostUsd.toFixed(9)),
        predictedCloudCostUsd: Number(this.totalPredictedCostUsd.toFixed(9)),
        costPerSuccessUsd: this.processed
          ? Number((this.totalActualCostUsd / this.processed).toFixed(9))
          : 0,
      },
      prediction: this._predictionStats(),
      // ML prediction metrics
      ml: {
        predictionCount: this.mlPredictionCount,
        errorCount: this.mlPredictionErrors,
        avgLatencyMs: this.mlPredictionCount > 0
          ? Number((this.mlTotalLatencySum / this.mlPredictionCount).toFixed(1))
          : 0,
        avgInferenceMs: this.mlPredictionCount > 0
          ? Number((this.mlInferenceLatencySum / this.mlPredictionCount).toFixed(1))
          : 0,
        avgQueueWaitMs: this.mlPredictionCount > 0
          ? Number((this.mlQueueWaitSum / this.mlPredictionCount).toFixed(1))
          : 0,
      },
    };
  }
}

module.exports = MetricsStore;
