'use strict';

/**
 * ML Service Client
 * 
 * Communicates with the FastAPI ML service (/predict endpoint)
 * to get wall-time predictions from the RandomForest model.
 * 
 * No silent fallback to heuristic - failures are explicit.
 */

const config = require('../config');

class MLClient {
  constructor() {
    this.baseUrl = process.env.ML_SERVICE_URL || 'http://localhost:8000';
    this.timeout = Number(process.env.ML_CLIENT_TIMEOUT_MS || 30000); // 30s timeout
    this.requestCount = 0;
    this.errorCount = 0;
    this.totalLatencyMs = 0;
  }

  /**
   * Predict wall-clock execution time for a request.
   * 
   * @param {object} request - GatewayRequest object
   * @returns {Promise<object>} - { predictedCostMs, predictedCloudCostUsd, costTier, confidence, modelVersion }
   * @throws {Error} - If ML service is unavailable or returns error
   */
  async predict(request, systemState) {
    const startTime = Date.now();
    this.requestCount++;

    // Build request payload for ML service
    const payload = {
      type: request.type,
      payloadSize: request.payloadSize,
      iterations: request.parameters?.iterations || 0,
      priority: request.priority,
      precision: request.precision,
      requestId: request.requestId,
      systemState: systemState || {},
    };

    const url = `${this.baseUrl}/predict`;

    try {
      console.log(`[MLClient] Requesting prediction for ${request.type} (${request.requestId})`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const latencyMs = Date.now() - startTime;
      this.totalLatencyMs += latencyMs;

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`ML service returned ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      console.log(`[MLClient] Prediction received: ${data.predictedCostMs}ms, tier=${data.costTier}, latency=${latencyMs}ms`);

      return {
        predictedCostMs: data.predictedCostMs,
        predictedCloudCostUsd: data.predictedCloudCostUsd,
        costTier: data.costTier,
        confidence: data.confidence,
        modelVersion: data.modelVersion,
      };

    } catch (error) {
      const latencyMs = Date.now() - startTime;
      this.errorCount++;
      this.totalLatencyMs += latencyMs;

      console.error(`[MLClient] Prediction failed for ${request.type} (${request.requestId}): ${error.message}, latency=${latencyMs}ms`);
      throw error;
    }
  }

  /**
   * Check if ML service is healthy.
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get current client statistics.
   * @returns {object}
   */
  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      avgLatencyMs: this.requestCount > 0 ? Number((this.totalLatencyMs / this.requestCount).toFixed(1)) : 0,
    };
  }

  /**
   * Reset statistics.
   */
  resetStats() {
    this.requestCount = 0;
    this.errorCount = 0;
    this.totalLatencyMs = 0;
  }
}

module.exports = MLClient;