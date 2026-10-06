'use strict';
const fs = require('fs');
const path = require('path');
const before = require('../decision-audit-2026-10-06/report.json');
const after = require('./report.json');
const quantile = (values, fraction) => values.slice().sort((a,b)=>a-b)[Math.max(0, Math.ceil(values.length*fraction)-1)] ?? null;
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
const round = n => n == null ? '—' : Number(n.toFixed(3));
let md = '# Bounded prediction admission: before versus after\n\n';
md += 'Before: decision-audit-2026-10-06. After: this directory. Both use seed 42, five seconds of configured arrivals, unchanged simulator replay, fresh gateways, sequential baseline then predictive, and one excluded direct ML warmup. After uses the approved defaults: two active ML calls, four waiting entries, 50 ms normal/low and 100 ms high wait limits. No threshold tuning. These are single paired runs at different times, not controlled host-performance trials.\n\n';
const table = (title, headers, rows) => { md += `## ${title}\n\n| ${headers.join(' | ')} |\n| ${headers.map(()=> '---').join(' | ')} |\n${rows.map(row=>`| ${row.join(' | ')} |`).join('\n')}\n\n`; };
const comparisons = after.results.map(a => {
  const b=before.results.find(b=>b.profile===a.profile);
  const bt=require(`../decision-audit-2026-10-06/${a.profile}-requests.json`);
  const at=require(`./${a.profile}-requests.json`);
  const stats = (p,t) => {
    const s=p.predictive.snapshot;
    const success=t.requestRows.filter(r=>r.finalOutcome.status===200);
    return { requests:p.requests, gateRejections:s.predictionGate?.rejections??0,
      gateReasons:s.predictionGate?.rejectionReasons??{}, queuePeak:p.predictive.queue.peakQueued,
      meanQueueWaitMs:s.ml.avgQueueWaitMs, p95QueueWaitMs:quantile(t.predictionTimings.map(d=>d.queueWaitMs),.95),
      predictionThroughput:s.ml.predictionThroughputPerSec, predictionAttempts:s.ml.predictionCount,
      gatewayMeanMs:s.latency.avg, gatewayP95Ms:quantile(t.requestRows.map(r=>r.finalOutcome.latencyMs),.95),
      successfulGatewayMeanMs:mean(success.map(r=>r.finalOutcome.latencyMs)), successfulGatewayP95Ms:quantile(success.map(r=>r.finalOutcome.latencyMs),.95),
      slaMet:s.slaMet, processed:s.processed, baselineCost:p.baseline.snapshot.cost.estimatedCloudCostUsd,
      predictiveCost:s.cost.estimatedCloudCostUsd, decisions:[s.allowed,s.downgraded,s.delayed,s.rejected].join('/'),
      mlErrors:s.ml.errorCount, mlFallbacks:s.ml.fallbackCount, inFlight:s.inFlight };
  };
  const result={profile:a.profile,before:stats(b,bt),after:stats(a,at)};
  const g=a.predictive.snapshot.predictionGate;
  if (!a.validation.balanced || g.attempts !== a.predictive.snapshot.ml.predictionCount || g.admissions-g.expirations !== g.attempts || g.submissions !== a.requests || g.rejections !== a.predictive.snapshot.rejected) throw new Error(`Accounting mismatch ${a.profile}`);
  return result;
});
const pair=(c,k)=>`${round(c.before[k])} → ${round(c.after[k])}`;
table('Admission and outcomes', ['Profile','Requests before/after','Gate rejections before → after','After rejection reasons','Final A/D/L/R before → after','ML errors before → after'], comparisons.map(c=>[c.profile,`${c.before.requests}/${c.after.requests}`,pair(c,'gateRejections'),JSON.stringify(c.after.gateReasons),`${c.before.decisions} → ${c.after.decisions}`,pair(c,'mlErrors')]));
table('Prediction queue and throughput', ['Profile','Queue peak before → after','Mean wait ms before → after','p95 wait ms before → after','Predictions/s before → after','ML attempts before → after'], comparisons.map(c=>[c.profile,pair(c,'queuePeak'),pair(c,'meanQueueWaitMs'),pair(c,'p95QueueWaitMs'),pair(c,'predictionThroughput'),pair(c,'predictionAttempts')]));
table('Gateway latency and SLA', ['Profile','All-response mean ms before → after','All-response p95 ms before → after','Success mean ms before → after','Success p95 ms before → after','SLA-compliant before → after','Successful before → after'], comparisons.map(c=>[c.profile,pair(c,'gatewayMeanMs'),pair(c,'gatewayP95Ms'),pair(c,'successfulGatewayMeanMs'),pair(c,'successfulGatewayP95Ms'),`${c.before.slaMet}/${c.before.requests} → ${c.after.slaMet}/${c.after.requests}`,pair(c,'processed')]));
table('Existing execution cost estimates (USD)', ['Profile','Baseline before','Predictive before','Baseline after','Predictive after'], comparisons.map(c=>[c.profile,...[c.before.baselineCost,c.before.predictiveCost,c.after.baselineCost,c.after.predictiveCost].map(v=>v.toFixed(9))]));
md += 'Queue-wait statistics above cover predictions that actually started HTTP; gate expiry waits are recorded separately in gateEvents/gateWaitMs. p95 values use exact raw observations with nearest-rank percentiles, rather than the dashboard latency histogram. Prediction throughput covers the observed prediction interval, including drain; it is not requests divided by configured duration. All-response latency includes fast rejections, so successful-response latency is also reported. SLA counts require successful completion within the unchanged 250 ms threshold; rejections are not SLA-compliant.\n\n';
md += 'Lower execution cost following rejection means less completed work, not cost-aware optimization savings. Admitted requests still use the original DecisionEngine, full-precision executor, existing cache and rolling budget. No rejection distribution was targeted. Normal-profile rejection is an observed availability tradeoff of these initial conservative limits and must remain visible.\n\n';
md += 'Implementation: backend/src/config.js, backend/src/ml/predictionQueue.js, backend/src/gateways/predictiveGateway.js, backend/src/metrics/metricsStore.js. Tests: backend/test/predictionQueue.test.js and backend/test/predictionAdmission.test.js. Gate metrics are additive API fields; no dashboard changes. Configuration: PREDICTION_MAX_WAITING=4, PREDICTION_NORMAL_WAIT_MS=50, PREDICTION_HIGH_WAIT_MS=100. ML_CONCURRENCY retains its previous value.\n\n';
md += 'Validation: 47 backend tests and 8 Python tests passed. All six experiments have complete request outcomes, zero final inFlight, zero ML errors/fallbacks, and reconciled submission/admission/start/expiry counters. Source hashes remained unchanged during experiments. Protected DecisionEngine, cost formulas, workload/replay, frontend, Python sources, model and training hashes match the pre-change audit.\n';
fs.writeFileSync(path.join(__dirname,'comparison.json'),JSON.stringify(comparisons,null,2));
fs.writeFileSync(path.join(__dirname,'REPORT.md'),md);
console.log(md);
