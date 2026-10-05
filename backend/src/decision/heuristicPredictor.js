'use strict';

/**
 * Heuristic cost predictor.
 *
 * Provides a per-type median of observed wall-clock execution time.
 * Used as the ML fallback so the gateway never blocks on an external service.
 * In step 3 this will be swapped for a trained model behind the same interface.
 */
const config = require('../config');

/** Default per-type medians (ms) used before any observations exist. */
const DEFAULT_MEDIANS = {
  image_resize:    35,
  hash_compute:    30,
  db_query:        55, // I/O dominated
  report_generate: 70,
  ml_inference:    35,
};

/** Confidence per type (heuristic) */
const DEFAULT_CONFIDENCE = {
  image_resize:    0.65,
  hash_compute:    0.70,
  db_query:        0.55, // more variable
  report_generate: 0.60,
  ml_inference:    0.65,
};

class HeuristicPredictor {
  constructor() {
    this.samples = new Map();
    for (const type of Object.keys(config.requestTypes)) {
      this.samples.set(type, [DEFAULT_MEDIANS[type] || 40]);
    }
  }

  /**
   * @param {object} request - GatewayRequest
   * @returns {object} { predictedCostMs, predictedCloudCostUsd, costTier, confidence, modelVersion }
   */
  predict(request) {
    const type = request.type;
    const arr = this.samples.get(type) || [DEFAULT_MEDIANS[type] || 40];
    const sorted = [...arr].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const confidence = DEFAULT_CONFIDENCE[type] || 0.6;

    // cost tier thresholds
    let costTier = 'medium';
    if (median < 20) costTier = 'cheap';
    else if (median > 50) costTier = 'expensive';

    return {
      requestId: request.requestId,
      predictedCostMs: median,
      predictedCloudCostUsd: this._costFromMs(median, request.payloadSize),
      costTier,
      confidence,
      modelVersion: 'heuristic-v1',
    };
  }

  /** Update with a real observation. */
  observe(request, actualWallMs) {
    const arr = this.samples.get(request.type) || [];
    arr.push(actualWallMs);
    // keep last 200 observations per type
    if (arr.length > 200) arr.shift();
    this.samples.set(request.type, arr);
  }

  _costFromMs(ms, payloadSize) {
    const c = config.costModel;
    const billedMs = Math.max(c.minBilledMs, ms);
    const sec = billedMs / 1000;
    return Number((
      sec * c.vcpuCount * c.pricePerVcpuSec +
      sec * (c.memoryMB / 1024) * c.pricePerGbSec +
      c.pricePerInvocation +
      (payloadSize / 1e9) * c.pricePerGbEgress
    ).toFixed(9));
  }

  /** For debugging: current medians. */
  medians() {
    const out = {};
    for (const [type, arr] of this.samples.entries()) {
      const sorted = [...arr].sort((a, b) => a - b);
      out[type] = sorted[Math.floor(sorted.length / 2)];
    }
    return out;
  }
}

module.exports = HeuristicPredictor;