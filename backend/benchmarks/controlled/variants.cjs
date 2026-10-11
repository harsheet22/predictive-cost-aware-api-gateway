'use strict';
const { performance } = require('perf_hooks');
function configure(arm, config) {
  if (!['baseline', 'predictive', 'fifo', 'shadow', 'policy'].includes(arm)) throw new Error(`Unknown arm: ${arm}`);
  if (['fifo', 'shadow', 'policy'].includes(arm)) {
    config.predictive.downgrade.enabled = false;
    config.predictive.optimization.reducedQualityTypes = [];
    config.predictive.optimization.hashPrefixReuse = false;
    config.predictive.rateLimit.enabled = false;
    return ['benchmark-only: all downgrade disabled', 'benchmark-only: hash reuse disabled',
      'benchmark-only: response cache replaced with no-op', 'benchmark-only: predictive token limiter disabled'];
  }
  return [];
}
function create(arm, metrics, config) {
  if (arm === 'baseline') return new (require('../../src/gateways/baselineGateway'))(metrics);
  const Predictive = require('../../src/gateways/predictiveGateway');
  if (arm === 'predictive' || arm === 'policy') {
    const gateway = new Predictive(metrics);
    if (arm === 'policy') gateway.cache = { get: () => undefined, set: () => {}, stats: () => ({ disabledByBenchmark: true }) };
    return gateway;
  }
  // Existing primitives only. No cost/budget decisions or new scheduling policy.
  const { QueuedConcurrencyGuard } = require('../../src/decision/limiters');
  const gateway = arm === 'shadow' ? new Predictive(metrics) : { rate: new QueuedConcurrencyGuard({ maxConcurrent: config.predictive.maxConcurrent, maxQueue: config.predictive.maxQueue }) };
  gateway.handle = async request => {
    const started = performance.now(); metrics.begin();
    let execution, prediction, decision = 'ALLOW', reason = 'cost_blind_fifo', status = 200;
    try {
      if (arm === 'shadow') prediction = await gateway.predictor.predict(request, {});
      execution = await gateway.rate.run(() => require('../../src/workload/executor').execute(request, { precision: 'full' }));
    } catch (error) {
      decision = 'REJECT'; reason = error.reason || (error.code === 'SHED' ? 'load_shed' : error.code === 'ML_PREDICTION_FAILED' ? 'ml_prediction_failed' : 'execution_error'); status = 503;
    }
    const latencyMs = performance.now() - started;
    const outcome = { requestId: request.requestId, decision, reason, status, latencyMs,
      slaMet: status === 200 && latencyMs <= config.sla.targetLatencyMs,
      precision: 'full', cached: false, actualCostMs: execution?.wallMs || 0,
      actualCloudCostUsd: execution?.actualCloudCostUsd || 0, predictedCostMs: prediction?.predictedCostMs ?? null };
    metrics.record({ ...outcome, actualCostUsd: outcome.actualCloudCostUsd, predictedCostUsd: prediction?.predictedCloudCostUsd ?? null });
    return outcome;
  };
  return gateway;
}
module.exports = { configure, create };
