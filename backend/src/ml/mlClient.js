'use strict';

const { performance } = require('perf_hooks');

class MLPredictionError extends Error {
  constructor(cause, timings) {
    super(cause.message, { cause });
    this.name = 'MLPredictionError';
    this.code = 'ML_PREDICTION_FAILED';
    this.timings = timings;
  }
}

function serverTimings(header) {
  const values = {};
  for (const part of (header || '').split(',')) {
    const match = part.trim().match(/^([a-z_]+);dur=([0-9.]+)$/);
    if (match && Number.isFinite(Number(match[2]))) values[match[1]] = Number(match[2]);
  }
  return values;
}

/** HTTP timeout includes response-body consumption. Queue waiting is timed by
 * the gateway separately. Failures are explicit; this client has no fallback. */
class MLClient {
  constructor() {
    this.baseUrl = process.env.ML_SERVICE_URL || 'http://localhost:8000';
    this.timeout = Number(process.env.ML_CLIENT_TIMEOUT_MS || 30000);
    this.resetStats();
  }

  async predict(request, systemState) {
    const started = performance.now();
    this.requestCount++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    let server = {};
    const timings = () => {
      const httpMs = performance.now() - started;
      return {
        httpMs,
        fastapiMs: server.fastapi ?? null,
        inferenceMs: server.rf ?? null,
        workerQueueMs: server.worker_queue ?? null,
        // Residual includes transport, body parsing and client/event-loop
        // scheduling. It is not a measurement of pure wire latency.
        networkResidualMs: server.fastapi == null ? null : Math.max(0, httpMs - server.fastapi),
      };
    };
    try {
      const response = await fetch(`${this.baseUrl}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: request.type,
          payloadSize: request.payloadSize,
          iterations: request.parameters?.iterations || 0,
          priority: request.priority,
          precision: request.precision,
          requestId: request.requestId,
          systemState: systemState || {},
        }),
        signal: controller.signal,
      });
      server = serverTimings(response.headers.get('server-timing'));
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ML service returned ${response.status}: ${errorText}`);
      }
      const data = await response.json();
      if (!Number.isFinite(data.predictedCostMs) || data.predictedCostMs < 0 ||
          !Number.isFinite(data.predictedCloudCostUsd) || data.predictedCloudCostUsd < 0 ||
          !Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1 ||
          !['cheap', 'medium', 'expensive'].includes(data.costTier) ||
          typeof data.modelVersion !== 'string') {
        throw new Error('ML service returned an invalid prediction');
      }
      const fallbackReason = response.headers.get('x-prediction-fallback') || null;
      if (fallbackReason) {
        this.errorCount++;
        this.fallbackCount++;
      }
      return {
        predictedCostMs: data.predictedCostMs,
        predictedCloudCostUsd: data.predictedCloudCostUsd,
        costTier: data.costTier,
        confidence: data.confidence,
        modelVersion: data.modelVersion,
        timings: timings(),
        fallbackReason,
      };
    } catch (error) {
      this.errorCount++;
      throw new MLPredictionError(error, timings());
    } finally {
      clearTimeout(timeoutId);
      this.totalLatencyMs += performance.now() - started;
    }
  }

  async healthCheck() {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET', signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch { return false; }
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      fallbackCount: this.fallbackCount,
      avgLatencyMs: this.requestCount ? Number((this.totalLatencyMs / this.requestCount).toFixed(3)) : 0,
    };
  }

  resetStats() {
    this.requestCount = 0;
    this.errorCount = 0;
    this.fallbackCount = 0;
    this.totalLatencyMs = 0;
  }
}

module.exports = MLClient;
