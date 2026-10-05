'use strict';

/**
 * Day-1 proof: drive a seeded workload through the PREDICTIVE gateway and print
 * a metrics snapshot.
 *
 * Usage: node backend/scripts/demo.js predictive [profile] [durationSec] [seed]
 */
const config = require('../src/config');
const MetricsStore = require('../src/metrics/metricsStore');
const PredictiveGateway = require('../src/gateways/predictiveGateway');
const { generateRequests, replay } = require('../src/simulator/simulator');

function formatSnapshot(s) {
  const pct = (v) => `${String(v).padStart(6)} ms`;
  return [
    `  incoming            : ${s.incoming}`,
    `  processed (2xx)     : ${s.processed}`,
    `  rejected            : ${s.rejected}  (429:${s.rateLimited} 503:${s.shed})`,
    `  delayed             : ${s.delayed}`,
    `  downgraded          : ${s.downgraded}`,
    `  SLA met             : ${s.slaMet}/${s.processed}`,
    `  throughput          : ${s.rps} req/s`,
    `  latency p50/p95/p99 : ${pct(s.latency.p50)} / ${pct(s.latency.p95)} / ${pct(s.latency.p99)}`,
    `  max concurrency     : ${s.utilization.maxConcurrency}`,
    `  cpu (last sample)   : ${s.utilization.cpuPct}%`,
    `  est. cloud cost     : $${s.cost.estimatedCloudCostUsd.toFixed(6)}`,
    `  cost / success      : $${s.cost.costPerSuccessUsd.toFixed(9)}`,
    `  prediction MAE      : ${s.prediction.maeMs} ms`,
  ].join('\n');
}

async function main() {
  const gatewayName = process.argv[2] || 'predictive';
  const profile = process.argv[3] || 'normal';
  const durationSec = Number(process.argv[4] || 10);
  const seed = Number(process.argv[5] || 42);

  if (gatewayName === 'baseline') {
    const BaselineGateway = require('../src/gateways/baselineGateway');
    const metrics = new MetricsStore('baseline');
    const gateway = new BaselineGateway(metrics);
    await run(gateway, metrics, profile, durationSec, seed);
    return;
  }

  const metrics = new MetricsStore('predictive');
  const gateway = new PredictiveGateway(metrics);
  await run(gateway, metrics, profile, durationSec, seed);
}

async function run(gateway, metrics, profile, durationSec, seed) {
  const requests = generateRequests({ profile, durationSec, seed });
  console.log(`[demo] ${gateway.name.toUpperCase()} profile=${profile} duration=${durationSec}s seed=${seed}`);
  console.log(`[demo] generated ${requests.length} requests (deterministic)`);

  const pending = new Set();
  const t0 = Date.now();
  await replay(requests, (request) => {
    const p = gateway.handle(request).catch(() => {});
    pending.add(p);
    p.finally(() => pending.delete(p));
  });
  while (pending.size > 0) await new Promise((r) => setTimeout(r, 25));
  const elapsedSec = (Date.now() - t0) / 1000;

  await new Promise((r) => setTimeout(r, 1100));

  console.log(`\n[demo] finished in ${elapsedSec.toFixed(1)}s`);
  console.log('--------------------------------------------------');
  console.log(`${gateway.name.toUpperCase()} GATEWAY (${config.sla.targetLatencyMs} ms SLA target)`);
  console.log('--------------------------------------------------');
  console.log(formatSnapshot(metrics.snapshot()));
  console.log('--------------------------------------------------');
  if (gateway.stats) {
    console.log('Extras:', JSON.stringify(gateway.stats(), null, 2));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[demo] failed:', err);
  process.exit(1);
});