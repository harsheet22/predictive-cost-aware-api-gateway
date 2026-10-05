'use strict';

/**
 * Showcase script: runs a workload with overridden config to demonstrate
 * all four decisions (ALLOW, DELAY, DOWNGRADE, REJECT) in one run.
 */

// Override config BEFORE requiring modules
process.env.PREDICTIVE_MAX_CONCURRENT = '4';
process.env.PREDICTIVE_MAX_QUEUE = '8';
process.env.BUDGET_USD_PER_WINDOW = '0.0008';

const config = require('../src/config');
config.predictive.maxConcurrent = 4;
config.predictive.maxQueue = 8;
config.predictive.budget.usdPerWindow = 0.0008;

const MetricsStore = require('../src/metrics/metricsStore');
const PredictiveGateway = require('../src/gateways/predictiveGateway');
const { generateRequests, replay } = require('../src/simulator/simulator');

const metrics = new MetricsStore('showcase');
const gateway = new PredictiveGateway(metrics);

const requests = generateRequests({ profile: 'demo', durationSec: 5, seed: 42 });
console.log(`[showcase] Generated ${requests.length} requests`);
console.log('[showcase] Config: maxConcurrent=4, maxQueue=8, budget=$0.0008/10s\n');

const decisionCounts = { ALLOW: 0, DELAY: 0, DOWNGRADE: 0, REJECT: 0 };
const reasonCounts = {};

async function run() {
  const pending = new Set();
  await replay(requests, (request) => {
    const p = gateway.handle(request).then((result) => {
      decisionCounts[result.decision] = (decisionCounts[result.decision] || 0) + 1;
      reasonCounts[result.reason] = (reasonCounts[result.reason] || 0) + 1;
    }).catch(() => {});
    pending.add(p);
    p.finally(() => pending.delete(p));
  });
  while (pending.size > 0) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 1100));

  const snap = metrics.snapshot();
  console.log('=== DECISION BREAKDOWN ===');
  console.log(`ALLOW     : ${decisionCounts.ALLOW || 0}`);
  console.log(`DELAY     : ${decisionCounts.DELAY || 0}`);
  console.log(`DOWNGRADE : ${decisionCounts.DOWNGRADE || 0}`);
  console.log(`REJECT    : ${decisionCounts.REJECT || 0}`);
  console.log('\n=== REASONS ===');
  for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`);
  }
  console.log('\n=== METRICS SNAPSHOT ===');
  console.log(`Processed: ${snap.processed}`);
  console.log(`Rejected : ${snap.rejected}`);
  console.log(`Delayed  : ${snap.delayed}`);
  console.log(`Downgraded: ${snap.downgraded}`);
  console.log(`SLA Met  : ${snap.slaMet}/${snap.processed}`);
  console.log(`Cost     : $${snap.cost.estimatedCloudCostUsd.toFixed(6)}`);
  console.log(`Cost/Succ: $${snap.cost.costPerSuccessUsd.toFixed(9)}`);
  console.log(`Cache    : ${snap.cache.hits} hits, ${snap.cache.misses} misses (${(snap.cache.hitRatio * 100).toFixed(1)}%)`);
  console.log('\n=== GATEWAY STATE ===');
  console.log(gateway.stats());
}

run().catch(console.error);