'use strict';

/**
 * Predictive gateway: cost-aware admission with ALLOW / DELAY / DOWNGRADE / REJECT.
 *
 * Flow:
 *   1. Predict cost (ML service or heuristic fallback)
 *   2. Decision engine evaluates budget, utilization, queue
 *   3. Execute or shed based on decision
 *   4. Cache results for DOWNGRADE path
 *   5. Observe actual cost to improve predictions
 */
const config = require('../config');
const { execute } = require('../workload/executor');
const { TokenBucket, QueuedConcurrencyGuard, ShedError } = require('../decision/limiters');
const { DecisionEngine, RollingBudget } = require('../decision/decisionEngine');
const MLClient = require('../ml/mlClient');
const LRUCache = require('../decision/cache');
const PredictionQueue = require('../ml/predictionQueue');

class PredictiveGateway {
  constructor(metrics) {
    this.name = 'predictive';
    this.metrics = metrics;

    // Admission control
    this.rate = new QueuedConcurrencyGuard({
      maxConcurrent: config.predictive.maxConcurrent,
      maxQueue: config.predictive.maxQueue,
    });

    // ML client for cost prediction
    this.mlClient = new MLClient();

    // Prediction queue with bounded concurrency
    this.predictionQueue = new PredictionQueue(config.predictive.mlConcurrency || 4);

    // Cost prediction + decision
    this.predictor = this._createMLPredictor();
    this.budget = new RollingBudget(
      config.predictive.budget.windowMs,
      config.predictive.budget.usdPerWindow,
    );
    this.engine = new DecisionEngine(this.predictor, this.budget);

    // Cache for downgraded results
    this.cache = new LRUCache(config.predictive.cache);

    // Token bucket for baseline-style rate limiting (in front of the queue)
    this.rateLimit = new TokenBucket(config.predictive.rateLimit);
  }

  /**
   * Create a predictor interface that uses the ML client with bounded concurrency.
   * Uses PredictionQueue to limit concurrent ML predictions.
   */
  _createMLPredictor() {
    const self = this;
    return {
      async predict(request, systemState) {
        const overallStartTime = Date.now();
        
        // Use prediction queue for bounded concurrency
        const prediction = await self.predictionQueue.run(async () => {
          const mlStartTime = Date.now();
          try {
            const prediction = await self.mlClient.predict(request, systemState);
            const mlLatencyMs = Date.now() - mlStartTime;
            
            // Record ML-specific latency breakdown
            self.metrics.recordMLPredictionDetail({
              totalLatencyMs: Date.now() - overallStartTime,
              mlInferenceMs: mlLatencyMs,
              queueWaitMs: mlStartTime - overallStartTime,
              success: true,
            });
            
            console.log(`[PredictiveGateway] ML prediction: ${prediction.predictedCostMs}ms, tier=${prediction.costTier}, latency=${mlLatencyMs}ms`);
            return prediction;
          } catch (error) {
            const mlLatencyMs = Date.now() - mlStartTime;
            self.metrics.recordMLPredictionDetail({
              totalLatencyMs: Date.now() - overallStartTime,
              mlInferenceMs: mlLatencyMs,
              queueWaitMs: mlStartTime - overallStartTime,
              success: false,
            });
            console.error(`[PredictiveGateway] ML prediction failed for ${request.type}: ${error.message}`);
            throw error;
          }
        });
        
        // Record overall prediction latency
        const totalLatencyMs = Date.now() - overallStartTime;
        self.metrics.recordMLPrediction(totalLatencyMs, true);
        
        return prediction;
      },

      observe(request, actualWallMs) {
        // No-op for ML predictor (online learning is handled by ML service if needed)
        // Could be extended to send feedback to ML service
      },

      medians() {
        return { note: 'Using ML service for predictions' };
      }
    };
  }

  async handle(request) {
    const started = process.hrtime.bigint();
    this.metrics.begin();

    // Quick rate-limit check (fast fail)
    if (config.predictive.rateLimit.enabled) {
      if (!this.rateLimit.tryTake()) {
        return this._finish({
          decision: 'REJECT',
          reason: 'rate_limited',
          status: 429,
          latencyMs: 0,
          slaMet: false,
          predictedCostMs: 0,
          predictedCostUsd: 0,
        });
      }
    }

    // System state snapshot for the decision engine
    // Use gateway-local concurrency pressure instead of process-wide CPU %
    // (process CPU % is polluted by the other gateway's run in comparison mode)
    const concurrencyPressure = this.rate.active / config.predictive.maxConcurrent;
    const queuePressure = this.rate.queue.length / config.predictive.maxQueue;
    const cpuPct = Math.max(concurrencyPressure, queuePressure) * 100;

    const systemState = {
      cpuPct,
      queueDepth: this.rate.queue.length,
      concurrent: this.rate.active,
    };

    // Get decision (async)
    const decision = await this.engine.decide(request, systemState);

    let execution = null;
    let finalDecision = decision.decision;
    let finalReason = decision.reason;
    let status = 200;
    let precision = request.precision;
    let delayMs = 0;

    // Cache key for downgraded results (based on itemId + type)
    const cacheKey = this._cacheKey(request);

    try {
      switch (decision.decision) {
        case 'ALLOW':
          execution = await this._executeWithQueue(request, 'full');
          break;

        case 'DOWNGRADE': {
          // Check cache first
          const cached = this.cache.get(cacheKey);
          if (cached) {
            execution = cached;
            execution.cached = true;
            this.metrics.recordCacheHit();
            finalReason = 'downgraded_cached';
          } else {
            execution = await this._executeWithQueue(request, 'reduced');
            this.cache.set(cacheKey, execution);
            this.metrics.recordCacheMiss();
            finalReason = 'downgraded_computed';
          }
          break;
        }

        case 'DELAY': {
          delayMs = decision.delayMs || config.predictive.delay.maxWaitMs;
          await new Promise(r => setTimeout(r, delayMs));
          // Re-evaluate after delay
          const reDecision = await this.engine.decide(request, systemState);
          if (reDecision.decision === 'REJECT') {
            finalDecision = 'REJECT';
            finalReason = 'delayed_then_rejected';
            status = 503;
            break;
          }
          finalDecision = reDecision.decision;
          finalReason = reDecision.reason;
          precision = reDecision.downgradeTo || 'full';
          execution = await this._executeWithQueue(request, precision);
          break;
        }

        case 'REJECT':
          finalDecision = 'REJECT';
          status = decision.reason === 'budget_exceeded' ? 429 : 503;
          break;
      }
    } catch (err) {
      if (err instanceof ShedError) {
        finalDecision = 'REJECT';
        finalReason = 'load_shed';
        status = 503;
      } else {
        finalDecision = 'REJECT';
        finalReason = 'execution_error';
        status = 500;
      }
    }

    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    const slaMet = status === 200 && latencyMs <= config.sla.targetLatencyMs;

    // Record actual cost for learning
    if (execution) {
      await this.engine.observe(request, execution.wallMs);
    }

    const result = {
      decision: finalDecision,
      reason: finalReason,
      status,
      latencyMs,
      slaMet,
      actualCostMs: execution ? execution.wallMs : 0,
      actualCostUsd: execution ? execution.actualCloudCostUsd : 0,
      predictedCostMs: decision.predictedCostMs,
      predictedCostUsd: decision.predictedCloudCostUsd,
      delayMs,
      precision: execution ? execution.precision : precision,
      cached: execution ? execution.cached : false,
    };

    return this._finish(result);

    // Release rate-limit token on non-rejected paths
    if (config.predictive.rateLimit.enabled && finalDecision !== 'REJECT') {
      this.rateLimit.granted++; // re-balance; simple approach
    }
  }

  /**
   * Execute a request through the bounded queue.
   * Returns the execution result or throws ShedError.
   */
  async _executeWithQueue(request, precision) {
    const execPromise = () => execute(request, {
      precision,
      cpuFactor: precision === 'reduced' ? config.predictive.downgrade.cpuFactor : 1,
      ioFactor: precision === 'reduced' ? config.predictive.downgrade.ioFactor : 1,
    });

    return this.rate.run(execPromise);
  }

  _cacheKey(request) {
    const itemId = request.parameters?.itemId ?? request.requestId;
    return `${request.type}:${itemId}:reduced`;
  }

  _finish(outcome) {
    const latencyMs = Number(outcome.latencyMs.toFixed(3));
    const actualCostMs = outcome.actualCostMs ? Number(outcome.actualCostMs.toFixed(3)) : 0;
    const actualCostUsd = outcome.actualCostUsd ? Number(outcome.actualCostUsd.toFixed(9)) : 0;
    const predictedCostMs = outcome.predictedCostMs || 0;
    const predictedCostUsd = outcome.predictedCostUsd || 0;

    this.metrics.record({
      decision: outcome.decision,
      status: outcome.status,
      latencyMs,
      slaMet: outcome.slaMet,
      actualCostMs,
      actualCostUsd,
      predictedCostMs,
      predictedCostUsd,
    });

    return {
      requestId: outcome.requestId,
      type: outcome.type || '',
      priority: outcome.priority || '',
      decision: outcome.decision,
      reason: outcome.reason,
      status: outcome.status,
      latencyMs,
      slaMet: outcome.slaMet,
      actualCostMs,
      actualCloudCostUsd: actualCostUsd,
      predictedCostMs,
      predictedCloudCostUsd: predictedCostUsd,
      delayMs: outcome.delayMs || 0,
      precision: outcome.precision || 'full',
      cached: outcome.cached || false,
    };
  }

  /** Synchronous completion hook for rate limiter (when we reject early). */
  _releaseRateToken() {
    if (config.predictive.rateLimit.enabled) {
      this.rateLimit.granted++;
    }
  }

  stats() {
    return {
      rate: { active: this.rate.active, queued: this.rate.queue.length, shed: this.rate.shed },
      budget: { remainingUsd: this.budget.remainingUsd(), utilized: this.budget.utilizationFraction() },
      cache: this.cache.stats(),
      predictor: this.predictor.medians(),
    };
  }
}

module.exports = PredictiveGateway;