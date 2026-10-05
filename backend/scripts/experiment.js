#!/usr/bin/env node

/**
 * Experiment Runner - automated comparison across all workload profiles.
 *
 * Runs the identical seeded workload through both gateways for each profile
 * and exports comparison results as JSON and CSV for analysis/reporting.
 */

const http = require('http');

const BACKEND_URL = 'http://localhost:3000';
const ML_URL = 'http://localhost:8000';

const PROFILES = [
  { id: 'light', name: 'Light', durationSec: 10 },
  { id: 'normal', name: 'Normal', durationSec: 10 },
  { id: 'mixed', name: 'Mixed', durationSec: 10 },
  { id: 'burst', name: 'Burst', durationSec: 5 },
  { id: 'heavy_tail', name: 'Heavy Tail', durationSec: 10 },
  { id: 'stress', name: 'Stress', durationSec: 3 },
  { id: 'overload', name: 'Overload', durationSec: 2 },
  { id: 'demo', name: 'Demo (tuned)', durationSec: 5 },
];

const SEED = 42;

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, BACKEND_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => raw += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BACKEND_URL);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
      let raw = '';
      res.on('data', (chunk) => raw += chunk);
      res.on('end', () => resolve(JSON.parse(raw)));
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkServices() {
  try {
    await getJson('/api/health');
    console.log('✓ Backend API reachable');
  } catch (e) {
    throw new Error('Backend API not reachable at ' + BACKEND_URL);
  }

  try {
    const ml = await new Promise((resolve, reject) => {
      const url = new URL('/health', ML_URL);
      http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
        let raw = '';
        res.on('data', (c) => raw += c);
        res.on('end', () => resolve(JSON.parse(raw)));
      }).on('error', reject);
    });
    if (ml.modelLoaded) console.log('✓ ML Service reachable (model loaded)');
    else console.log('⚠ ML Service reachable (heuristic fallback)');
  } catch (e) {
    console.log('⚠ ML Service not reachable, will use heuristic fallback');
  }
}

async function runProfile(profile) {
  console.log(`\n▶ Running profile: ${profile.name} (${profile.durationSec}s, seed ${SEED})`);

  // Reset metrics before each run
  try {
    await postJson('/api/metrics/reset', {});
  } catch (e) {
    console.warn('  Could not reset metrics:', e.message);
  }

  // Run comparison
  const result = await postJson('/api/compare/run', {
    profile: profile.id,
    durationSec: profile.durationSec,
    seed: SEED,
  });

  return result;
}

function formatNumber(n, decimals = 2) {
  if (n === undefined || n === null) return 'N/A';
  return Number(n).toFixed(decimals);
}

function formatPercent(n) {
  if (n === undefined || n === null) return 'N/A';
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

function printSummary(results) {
  console.log('\n' + '='.repeat(100));
  console.log('EXPERIMENT SUMMARY');
  console.log('='.repeat(100));

  console.log(
    'Profile'.padEnd(18) +
    'Baseline Cost'.padEnd(16) +
    'Predictive Cost'.padEnd(16) +
    'Savings %'.padEnd(12) +
    'Baseline p95'.padEnd(14) +
    'Pred p95'.padEnd(10) +
    'Baseline SLA%'.padEnd(14) +
    'Pred SLA%'.padEnd(12) +
    'Cost/Succ Δ%'.padEnd(12)
  );
  console.log('-'.repeat(100));

  for (const r of results) {
    const s = r.savings;
    const b = r.summary.baseline;
    const p = r.summary.predictive;

    console.log(
      r.profile.padEnd(18) +
      '$' + formatNumber(b.costUsd, 6).padEnd(15) +
      '$' + formatNumber(p.costUsd, 6).padEnd(15) +
      formatPercent(s.percent).padEnd(12) +
      (b.p95 + 'ms').padEnd(14) +
      (p.p95 + 'ms').padEnd(10) +
      (b.slaMetRate * 100).toFixed(1).padEnd(14) +
      (p.slaMetRate * 100).toFixed(1).padEnd(12) +
      formatPercent(s.costPerSuccessDelta / b.costPerSuccess * 100).padEnd(12)
    );
  }
}

function writeJsonReport(results) {
  const fs = require('fs');
  const path = require('path');
  const outDir = path.join(__dirname, '..', 'experiments');
  fs.mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `experiment-${timestamp}.json`);
  const csvPath = path.join(outDir, `experiment-${timestamp}.csv`);

  // JSON report
  const report = {
    timestamp: new Date().toISOString(),
    seed: SEED,
    profiles: results.map(r => ({
      profile: r.profile,
      durationSec: r.durationSec,
      totalRequests: r.totalRequests,
      seed: r.seed,
      baseline: r.baseline,
      predictive: r.predictive,
      savings: r.savings,
      summary: r.summary,
    })),
  };

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\n✓ JSON report written: ${jsonPath}`);

  // CSV summary
  const csvRows = [
    [
      'profile', 'durationSec', 'totalRequests', 'seed',
      'baseline_processed', 'baseline_rejected', 'baseline_p95_ms',
      'baseline_cost_usd', 'baseline_cost_per_success_usd', 'baseline_sla_met_rate',
      'predictive_processed', 'predictive_rejected', 'predictive_delayed', 'predictive_downgraded',
      'predictive_p95_ms', 'predictive_cost_usd', 'predictive_cost_per_success_usd', 'predictive_sla_met_rate',
      'savings_absolute_usd', 'savings_percent', 'sla_met_delta', 'cost_per_success_delta_usd',
      'prediction_mae_ms', 'prediction_rmse_ms', 'prediction_r2'
    ].join(','),
  ];

  for (const r of results) {
    const b = r.summary.baseline;
    const p = r.summary.predictive;
    const s = r.savings;
    const pred = r.predictive.prediction || {};

    csvRows.push([
      r.profile, r.durationSec, r.totalRequests, r.seed,
      b.processed, b.rejected, b.p95,
      b.costUsd, b.costPerSuccess, b.slaMetRate,
      p.processed, p.rejected, p.delayed, p.downgraded,
      p.p95, p.costUsd, p.costPerSuccess, p.slaMetRate,
      s.absoluteUsd, s.percent, s.slaMetDelta, s.costPerSuccessDelta,
      pred.maeMs || '', pred.rmseMs || '', pred.r2 || '',
    ].join(','));
  }

  fs.writeFileSync(csvPath, csvRows.join('\n'));
  console.log(`✓ CSV report written: ${csvPath}`);

  return { jsonPath, csvPath };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  Predictive Gateway - Automated Experiment Runner                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`Backend: ${BACKEND_URL}`);
  console.log(`ML Service: ${ML_URL}`);
  console.log(`Seed: ${SEED}`);
  console.log(`Profiles: ${PROFILES.length}`);

  await checkServices();

  const results = [];
  for (const profile of PROFILES) {
    try {
      const result = await runProfile(profile);
      results.push(result);
      console.log(`  ✓ Completed (${result.totalRequests} requests)`);
    } catch (e) {
      console.error(`  ✗ Failed: ${e.message}`);
      results.push({ profile: profile.id, error: e.message });
    }
    await sleep(1000); // brief pause between runs
  }

  printSummary(results.filter(r => !r.error));
  writeJsonReport(results.filter(r => !r.error));

  console.log('\n✓ All experiments completed.');
}

main().catch((e) => {
  console.error('\n✗ Experiment runner failed:', e.message);
  process.exit(1);
});