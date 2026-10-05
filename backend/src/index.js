'use strict';

/**
 * Backend entry point.
 *
 * Registers both gateways and the comparison experiment runner.
 */
const express = require('express');
const config = require('./config');
const MetricsStore = require('./metrics/metricsStore');
const BaselineGateway = require('./gateways/baselineGateway');
const PredictiveGateway = require('./gateways/predictiveGateway');
const { generateRequests, replay } = require('./simulator/simulator');

const healthRouter = require('./routes/health');
const metricsRouter = require('./routes/metrics');
const executeRouter = require('./routes/execute');

const baselineMetrics = new MetricsStore('baseline');
const baselineGateway = new BaselineGateway(baselineMetrics);

const predictiveMetrics = new MetricsStore('predictive');
const predictiveGateway = new PredictiveGateway(predictiveMetrics);

const gateways = {
  baseline: baselineGateway,
  predictive: predictiveGateway,
};

const app = express();
app.use(express.json({ limit: '2mb' }));

// Permissive CORS so the React dashboard (different port) can poll directly.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.get('/', (req, res) => {
  res.json({
    name: 'predictive-gateway-backend',
    gateways: Object.keys(gateways),
    endpoints: [
      'GET  /api/health',
      'GET  /api/metrics/live',
      'POST /api/metrics/reset',
      'POST /api/execute',
      'POST /api/compare/run',
    ],
  });
});

app.use('/api/health', healthRouter());
app.use('/api/metrics', metricsRouter({ gateways }));
app.use('/api/execute', executeRouter({ gateways }));

/**
 * POST /api/compare/run
 *
 * Runs an identical seeded workload through both gateways and returns
 * a comparison summary. Body:
 * {
 *   "profile": "normal",        // light|normal|burst|heavy_tail|mixed
 *   "durationSec": 10,
 *   "seed": 42
 * }
 */
app.post('/api/compare/run', async (req, res) => {
  const { profile = 'normal', durationSec = 10, seed = 42 } = req.body || {};

  // Generate the identical request stream for both runs
  const requests = generateRequests({ profile, durationSec, seed });

  // Reset metrics
  baselineMetrics.reset();
  predictiveMetrics.reset();

  // Helper: run one gateway with the same stream
  const runGateway = async (gateway, name) => {
    const pending = new Set();
    await replay(requests, (request) => {
      const p = gateway.handle(request).catch(() => {});
      pending.add(p);
      p.finally(() => pending.delete(p));
    });
    while (pending.size > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // Mark experiment end for this gateway
    gateway.metrics.markExperimentEnd();
    return gateway.metrics.snapshot();
  };

  // Sequential runs for isolation (avoid cross-contamination of CPU samples)
  // Each gateway gets its own experiment start time with the configured workload duration
  baselineMetrics.markExperimentStart(durationSec);
  const baselineSnap = await runGateway(baselineGateway, 'baseline');

  predictiveMetrics.markExperimentStart(durationSec);
  const predictiveSnap = await runGateway(predictiveGateway, 'predictive');

  // Compute savings
  const savingsUsd = baselineSnap.cost.estimatedCloudCostUsd - predictiveSnap.cost.estimatedCloudCostUsd;
  const savingsPct = baselineSnap.cost.estimatedCloudCostUsd > 0
    ? (savingsUsd / baselineSnap.cost.estimatedCloudCostUsd) * 100
    : 0;
  const slaDelta = predictiveSnap.slaMet - baselineSnap.slaMet;

  // Calculate experiment throughput summary
  const baselineThroughput = baselineSnap.experimentThroughput || {};
  const predictiveThroughput = predictiveSnap.experimentThroughput || {};

  res.json({
    runId: `cmp-${Date.now()}`,
    profile,
    durationSec,
    seed,
    totalRequests: requests.length,
    baseline: baselineSnap,
    predictive: predictiveSnap,
    // Experiment throughput summary (requests/second based on workload duration)
    throughput: {
      baseline: {
        incomingPerSec: baselineThroughput.incomingPerSec || 0,
        processedPerSec: baselineThroughput.processedPerSec || 0,
        rejectedPerSec: baselineThroughput.rejectedPerSec || 0,
        delayedPerSec: baselineThroughput.delayedPerSec || 0,
        downgradedPerSec: baselineThroughput.downgradedPerSec || 0,
      },
      predictive: {
        incomingPerSec: predictiveThroughput.incomingPerSec || 0,
        processedPerSec: predictiveThroughput.processedPerSec || 0,
        rejectedPerSec: predictiveThroughput.rejectedPerSec || 0,
        delayedPerSec: predictiveThroughput.delayedPerSec || 0,
        downgradedPerSec: predictiveThroughput.downgradedPerSec || 0,
      },
    },
    savings: {
      absoluteUsd: Number(savingsUsd.toFixed(9)),
      percent: Number(savingsPct.toFixed(1)),
      slaMetDelta: slaDelta,
      costPerSuccessDelta: Number((
        predictiveSnap.cost.costPerSuccessUsd - baselineSnap.cost.costPerSuccessUsd
      ).toFixed(9)),
    },
    summary: {
      baseline: {
        processed: baselineSnap.processed,
        rejected: baselineSnap.rejected,
        p95: baselineSnap.latency.p95,
        costUsd: baselineSnap.cost.estimatedCloudCostUsd,
        costPerSuccess: baselineSnap.cost.costPerSuccessUsd,
        slaMetRate: baselineSnap.processed ? baselineSnap.slaMet / baselineSnap.processed : 0,
      },
      predictive: {
        processed: predictiveSnap.processed,
        rejected: predictiveSnap.rejected,
        delayed: predictiveSnap.delayed,
        downgraded: predictiveSnap.downgraded,
        p95: predictiveSnap.latency.p95,
        costUsd: predictiveSnap.cost.estimatedCloudCostUsd,
        costPerSuccess: predictiveSnap.cost.costPerSuccessUsd,
        slaMetRate: predictiveSnap.processed ? predictiveSnap.slaMet / predictiveSnap.processed : 0,
        prediction: predictiveSnap.prediction,
      },
    },
  });
});

/** GET /api/compare/stream/:profile/:seed - return the generated request stream for inspection */
app.get('/api/compare/stream/:profile/:seed', (req, res) => {
  const { profile, seed } = req.params;
  const requests = generateRequests({ profile, durationSec: 5, seed: Number(seed) });
  res.json({ count: requests.length, requests: requests.slice(0, 5) });
});

// Fallback error handler so a bad request never takes the process down.
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('[backend] error:', err.message);
  res.status(500).json({ error: err.message });
});

if (require.main === module) {
  app.listen(config.ports.backend, () => {
    // eslint-disable-next-line no-console
    console.log(`[backend] listening on http://localhost:${config.ports.backend}`);
  });
}

module.exports = { app, gateways };