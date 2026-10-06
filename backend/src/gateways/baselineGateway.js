'use strict';

/**
 * Baseline gateway: traditional request-count / rate-based handling.
 *
 * It is deliberately COST-BLIND. It admits work while a fixed token bucket and
 * a fixed concurrency cap allow it, and rejects otherwise. It never predicts
 * cost, never delays, never downgrades.
 */
const config = require('../config');
const { execute } = require('../workload/executor');
const { TokenBucket, ConcurrencyGuard } = require('../decision/limiters');

class BaselineGateway {
  constructor(metrics) {
    this.name = 'baseline';
    this.metrics = metrics;
    this.rate = new TokenBucket(config.baseline.rateLimit);
    this.concurrency = new ConcurrencyGuard(config.baseline.maxConcurrent);
  }

  async handle(request) {
    const started = process.hrtime.bigint();
    this.metrics.begin();

    let decision = 'ALLOW';
    let reason = 'allowed';
    let status = 200;
    let execution = null;

    if (!this.rate.tryTake(1)) {
      decision = 'REJECT';
      reason = 'rate_limited';
      status = 429;
    } else if (!this.concurrency.tryAcquire()) {
      decision = 'REJECT';
      reason = 'concurrency_full';
      status = 503;
    } else {
      try {
        execution = await execute(request);
      } catch (err) {
        decision = 'REJECT';
        reason = 'execution_error';
        status = 500;
      } finally {
        this.concurrency.release();
      }
    }

    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    const slaMet = status === 200 && latencyMs <= config.sla.targetLatencyMs;

    this.metrics.record({
      decision,
      reason,
      status,
      latencyMs,
      slaMet,
      actualCostMs: execution ? execution.wallMs : undefined,
      actualCostUsd: execution ? execution.actualCloudCostUsd : undefined,
      predictedCostMs: null,
      predictedCostUsd: null,
    });

    return {
      requestId: request.requestId,
      type: request.type,
      priority: request.priority,
      decision,
      reason,
      status,
      latencyMs: Number(latencyMs.toFixed(3)),
      slaMet,
      actualCostMs: execution ? execution.wallMs : 0,
      actualCloudCostUsd: execution ? execution.actualCloudCostUsd : 0,
      predictedCostMs: null,
    };
  }

  stats() {
    return {
      rate: this.rate.stats(),
      concurrency: this.concurrency.stats(),
    };
  }
}

module.exports = BaselineGateway;
