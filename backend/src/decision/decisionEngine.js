'use strict';

/**
 * Decision engine: the brain of the predictive gateway.
 *
 * Given a request, its predicted cost, and current system state, it returns one of:
 *   ALLOW       - execute at full precision
 *   DELAY       - enqueue in the waiting room, retry after a short pause
 *   DOWNGRADE   - execute at reduced precision (cheaper, faster)
 *   REJECT      - fail fast with 429/503
 */
const config = require('../config');

/** Simple rolling budget tracker (USD per time window). */
class RollingBudget {
  constructor(windowMs, usdPerWindow) {
    this.windowMs = windowMs;
    this.usdPerWindow = usdPerWindow;
    this.spent = []; // { ts, usd }
  }

  /** Remove entries outside the rolling window. */
  _prune(now) {
    const cutoff = now - this.windowMs;
    while (this.spent.length && this.spent[0].ts < cutoff) this.spent.shift();
  }

  /** Record an actual cost. */
  recordCost(usd) {
    const now = Date.now();
    this._prune(now);
    this.spent.push({ ts: now, usd });
  }

  /** Current remaining budget in USD. */
  remainingUsd() {
    const now = Date.now();
    this._prune(now);
    const used = this.spent.reduce((sum, e) => sum + e.usd, 0);
    return Math.max(0, this.usdPerWindow - used);
  }

  /** Fraction of budget consumed (0..1). */
  utilizationFraction() {
    return 1 - this.remainingUsd() / this.usdPerWindow;
  }
}

/** Main decision logic. */
class DecisionEngine {
  constructor(predictor, budget) {
    this.predictor = predictor;
    this.budget = budget;
    this.downgradeEnabled = config.predictive.downgrade.enabled;
    this.delayEnabled = config.predictive.delay.enabled;
    this.maxWaitMs = config.predictive.delay.maxWaitMs;
  }

  /**
   * @param {object} request
   * @param {object} systemState - { cpuPct, queueDepth, concurrent, inBudgetWindow }
   * @returns {Promise<object>} decision object
   */
  async decide(request, systemState) {
    const prediction = await this.predictor.predict(request);
    const predictedMs = prediction.predictedCostMs;
    const predictedUsd = prediction.predictedCloudCostUsd;
    const budgetRemaining = this.budget.remainingUsd();
    const cheapShare = config.predictive.budget.cheapShare;

    // System pressure (from gateway's perspective)
    const cpuPct = systemState.cpuPct || 0;
    const queueDepth = systemState.queueDepth || 0;
    const concurrent = systemState.concurrent || 0;
    const maxConcurrent = config.predictive.maxConcurrent;

    const softLimit = config.predictive.utilization.softPct;
    const hardLimit = config.predictive.utilization.hardPct;
    const queueOk = queueDepth < config.predictive.maxQueue;
    const concurrencyOk = concurrent < maxConcurrent;

    const isCheap = predictedUsd <= budgetRemaining * cheapShare;
    const isExpensive = !isCheap;
    const budgetAllows = budgetRemaining > predictedUsd;

    // 1. CHEAP requests: ALLOW if budget permits and we have concurrency headroom
    // Never delay cheap requests due to queue pressure - that's the point of cost-awareness
    if (isCheap && budgetAllows && concurrencyOk) {
      return this._make('ALLOW', 'cheap_and_budget_ok', prediction, budgetRemaining);
    }

    // 2. EXPENSIVE requests: try DOWNGRADE first
    if (isExpensive && this.downgradeEnabled && this._canDowngrade(request)) {
      const downgradedMs = predictedMs * config.predictive.downgrade.cpuFactor;
      const downgradedUsd = this._predictCost(downgradedMs, request.payloadSize);
      const downgradeBudgetOk = downgradedUsd <= budgetRemaining * cheapShare || budgetRemaining > downgradedUsd;

      if (downgradeBudgetOk && concurrencyOk) {
        return this._make('DOWNGRADE', 'expensive_downgraded', prediction, budgetRemaining, {
          downgradeTo: 'reduced',
        });
      }
    }

    // 3. HIGH PRIORITY: override for important work if budget allows
    if (request.priority === 'high' && budgetAllows && concurrencyOk) {
      return this._make('ALLOW', 'high_priority_budget_ok', prediction, budgetRemaining);
    }

    // 4. EXPENSIVE requests under pressure: DELAY if queue has room
    // Only delay expensive requests - cheap ones already passed through above
    const underPressure = cpuPct >= softLimit || concurrent >= maxConcurrent;
    if (isExpensive && underPressure && this.delayEnabled && budgetRemaining > predictedUsd * 0.5 && queueOk) {
      return this._make('DELAY', 'expensive_under_pressure', prediction, budgetRemaining, {
        delayMs: this.maxWaitMs,
      });
    }

    // 5. CHEAP requests but no concurrency: brief DELAY (not reject)
    // Only if we're at concurrency limit but budget is fine
    if (isCheap && budgetAllows && !concurrencyOk && queueOk && this.delayEnabled) {
      return this._make('DELAY', 'cheap_concurrency_full', prediction, budgetRemaining, {
        delayMs: Math.min(this.maxWaitMs, 100), // shorter delay for cheap
      });
    }

    // 6. Default: REJECT
    const reason = budgetRemaining <= predictedUsd
      ? 'budget_exceeded'
      : cpuPct >= hardLimit
        ? 'cpu_hard_limit'
        : queueDepth >= config.predictive.maxQueue
          ? 'queue_full'
          : concurrent >= maxConcurrent
            ? 'concurrency_full'
            : 'budget_exceeded';

    return this._make('REJECT', reason, prediction, budgetRemaining);
  }

  _canDowngrade(request) {
    return request.precision !== 'reduced';
  }

  _predictCost(ms, payloadSize) {
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

  _make(decision, reason, prediction, budgetRemaining, extra = {}) {
    return {
      requestId: prediction.requestId,
      decision,
      reason,
      predictedCostMs: prediction.predictedCostMs,
      predictedCloudCostUsd: prediction.predictedCloudCostUsd,
      budgetRemainingUsd: budgetRemaining,
      costTier: prediction.costTier,
      confidence: prediction.confidence,
      modelVersion: prediction.modelVersion,
      ...extra,
    };
  }

  /** Called after execution to update the predictor with ground truth. */
  observe(request, actualWallMs) {
    this.predictor.observe(request, actualWallMs);
    this.budget.recordCost(this._predictCost(actualWallMs, request.payloadSize));
  }
}

module.exports = { DecisionEngine, RollingBudget };