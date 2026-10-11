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
const { performance } = require('perf_hooks');
const { execute } = require('../workload/executor');
const { TokenBucket, QueuedConcurrencyGuard, ShedError } = require('../decision/limiters');
const { DecisionEngine, RollingBudget } = require('../decision/decisionEngine');
const MLClient = require('../ml/mlClient');
const LRUCache = require('../decision/cache');
const PredictionQueue = require('../ml/predictionQueue');
const HashPrefixCache = require('../workload/hashPrefixCache');
const BudgetWaitQueue = require('../decision/budgetWaitQueue');

class PredictiveGateway {
  constructor(metrics) {
    this.name = 'predictive';
    this.metrics = metrics;
    this.hashPrefixCache = config.predictive.optimization.hashPrefixReuse ? new HashPrefixCache() : null;

    // Admission control
    this.rate = new QueuedConcurrencyGuard({
      maxConcurrent: config.predictive.maxConcurrent,
      maxQueue: config.predictive.maxQueue,
    });

    // ML client for cost prediction
    this.mlClient = new MLClient();

    // Prediction queue with bounded concurrency
    this.predictionQueue = new PredictionQueue(config.predictive.mlConcurrency || 4, {
      ...config.predictive.predictionAdmission,
      onEvent: event => this.metrics.recordPredictionGate(event),
    });

    // Cost prediction + decision
    this.predictor = this._createMLPredictor();
    this.budget = new RollingBudget(
      config.predictive.budget.windowMs,
      config.predictive.budget.usdPerWindow,
    );
    this.engine = new DecisionEngine(this.predictor, this.budget);
    this.budgetWaitQueue = new BudgetWaitQueue({
      maxWaiting: config.predictive.predictionAdmission.maxWaiting || 1,
      maxWaitMs: config.predictive.predictionAdmission.normalWaitMs,
    });

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
        const queuedAt = performance.now();
        return self.predictionQueue.run(async () => {
          const startedAt = performance.now();
          const queueWaitMs = startedAt - queuedAt;
          try {
            const prediction = await self.mlClient.predict(request, systemState);
            if (!prediction.fallbackReason) self.predictionQueue.recordHttpSuccess(prediction.timings?.httpMs);
            self.metrics.recordMLPredictionDetail({
              ...prediction.timings,
              totalLatencyMs: performance.now() - queuedAt,
              queueWaitMs,
              success: !prediction.fallbackReason,
              fallback: Boolean(prediction.fallbackReason),
            });
            return prediction;
          } catch (error) {
            self.metrics.recordMLPredictionDetail({
              ...error.timings,
              totalLatencyMs: performance.now() - queuedAt,
              queueWaitMs,
              success: false,
            });
            throw error;
          }
        }, { priority: request.priority, requestId: request.requestId });
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
    let decision;
    try {
      decision = await this.engine.decide(request, systemState);
      this.metrics.recordInitialDecision(decision);
    } catch (error) {
      // Complete this request exactly once, including metrics.begin()'s
      // inFlight increment. ML transport failures remain explicit rejections.
      return this._finish({
        decision: 'REJECT', reason: error.code === 'PREDICTION_ADMISSION_REJECTED' ? error.reason : 'ml_prediction_failed', status: 503,
        latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
        slaMet: false, predictedCostMs: 0, predictedCostUsd: 0,
      });
    }

    let execution = null;
    let finalDecision = decision.decision;
    let finalReason = decision.reason;
    let status = 200;
    let precision = request.precision;
    let delayMs = 0;

    // Cache key for downgraded results (based on itemId + type)
    const cacheKey = this._cacheKey(request);

    try {
      const fitsFreshBudget = decision.predictedCloudCostUsd <= this.budget.usdPerWindow * config.predictive.budget.cheapShare ||
        (request.priority === 'high' && decision.predictedCloudCostUsd < this.budget.usdPerWindow) ||
        (this.engine._canDowngrade(request) && this.engine._predictCost(decision.predictedCostMs * config.predictive.downgrade.cpuFactor, request.payloadSize) < this.budget.usdPerWindow);
      if (fitsFreshBudget && ((decision.decision === 'REJECT' && decision.reason === 'budget_exceeded') || this.budgetWaitQueue.queue.length)) {
        const savedPrediction = decision;
        const admission = await this.budgetWaitQueue.run(() => this.engine.decidePrediction(request, this._executionState(), savedPrediction));
        decision = admission.decision;
        delayMs = admission.waitMs;
        finalDecision = decision.decision;
        finalReason = decision.reason;
      }
      switch (decision.decision) {
        case 'ALLOW':
          execution = await this._executeWithQueue(request, 'full');
          break;

        case 'DOWNGRADE': {
          if (decision.reason === 'low_priority_reduced_quality') {
            // Fresh I/O per request; exact CPU reuse is independent of response caching.
            execution = await this._executeWithQueue(request, 'reduced');
            break;
          }
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
          const executionDelayMs = decision.delayMs || config.predictive.delay.maxWaitMs;
          delayMs += executionDelayMs;
          await new Promise(r => setTimeout(r, executionDelayMs));
          // Re-evaluate after delay
          let reDecision = this.engine.decidePrediction(request, this._executionState(), decision);
          if (fitsFreshBudget && reDecision.decision === 'REJECT' && reDecision.reason === 'budget_exceeded') {
            const admission = await this.budgetWaitQueue.run(() => this.engine.decidePrediction(request, this._executionState(), decision));
            delayMs += admission.waitMs;
            reDecision = admission.decision;
          }
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
      if (err.code === 'PREDICTION_ADMISSION_REJECTED' || err.code === 'BUDGET_WAIT_REJECTED') {
        finalDecision = 'REJECT';
        finalReason = err.reason;
        status = 503;
      } else if (err.code === 'ML_PREDICTION_FAILED') {
        finalDecision = 'REJECT';
        finalReason = 'ml_prediction_failed';
        status = 503;
      } else if (err instanceof ShedError) {
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
    if (delayMs > 0 && finalDecision === 'ALLOW') {
      finalDecision = 'DELAY';
      finalReason = 'budget_or_execution_wait';
    }
    const slaMet = status === 200 && latencyMs <= config.sla.targetLatencyMs;

    // Record actual cost for learning
    if (execution) {
      await this.engine.observe(request, execution.wallMs);
    }

    const result = {
      decision: finalDecision,
      decisionEngineReached: true,
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
      optimization: execution ? {
        cpuIterationsExecuted: execution.cpuIterationsExecuted || 0,
        cpuIterationsReused: execution.cpuIterationsReused || 0,
      } : null,
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
      hashPrefixCache: this.hashPrefixCache,
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
      reason: outcome.reason,
      status: outcome.status,
      latencyMs,
      slaMet: outcome.slaMet,
      actualCostMs,
      actualCostUsd,
      predictedCostMs,
      predictedCostUsd,
      decisionEngineReached: outcome.decisionEngineReached,
      precision: outcome.precision,
      cached: outcome.cached,
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
      optimization: outcome.optimization || null,
    };
  }

  /** Synchronous completion hook for rate limiter (when we reject early). */
  _releaseRateToken() {
    if (config.predictive.rateLimit.enabled) {
      this.rateLimit.granted++;
    }
  }

  _executionState() {
    return { concurrent: this.rate.active, queueDepth: this.rate.queue.length,
      cpuPct: Math.max(this.rate.active / config.predictive.maxConcurrent, this.rate.queue.length / config.predictive.maxQueue) * 100 };
  }

  stats() {
    return {
      predictionQueue: this.predictionQueue.stats(),
      rate: { active: this.rate.active, queued: this.rate.queue.length, shed: this.rate.shed },
      budget: { remainingUsd: this.budget.remainingUsd(), utilized: this.budget.utilizationFraction() },
      cache: this.cache.stats(),
      predictor: this.predictor.medians(),
      cpuReuse: this.hashPrefixCache ? this.hashPrefixCache.stats() : null,
      budgetWaitQueue: this.budgetWaitQueue.stats(),
    };
  }
}

module.exports = PredictiveGateway;
