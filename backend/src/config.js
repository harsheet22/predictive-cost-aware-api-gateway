'use strict';

/**
 * Backend configuration for the predictive cost-aware gateway demo.
 *
 * Everything is local and free. Price constants are illustrative numbers
 * modelled on serverless billing so the cost story is explainable, not real.
 */
const config = {
  ports: {
    backend: Number(process.env.BACKEND_PORT || 3000),
    ml: Number(process.env.ML_PORT || 8000),
    dashboard: Number(process.env.DASHBOARD_PORT || 5173),
  },

  // ---- Executor -----------------------------------------------------------
  executor: {
    // SHA-256 rounds per abstract "CPU unit". Calibrated on this machine at
    // ~3.5 us/round, so 400 units ~= 1.4 ms; tune with `npm run calibrate`.
    hashIterationsPerUnit: Number(process.env.HASH_ITERS_PER_UNIT || 400),
    // Minimum CPU rounds so even cheap jobs do measurable work.
    minHashIterations: 500,
    // Leftover iterations above this are treated as non-blocking (yielded),
    // which softens event-loop blocking for very heavy jobs. Set high to keep
    // jobs fully synchronous (more dramatic baseline collapse).
    syncIterationCap: Number(process.env.SYNC_ITERATION_CAP || 25000),
  },

  // ---- Job catalogue ------------------------------------------------------
  // cpuUnits -> hash rounds; ioMs -> simulated upstream wait. Identical for
  // both gateways because they share the executor.
  // payloadCpuFactor = extra CPU units per 1000 bytes of payload.
  requestTypes: {
    image_resize:    { cpuUnits: 12, ioMs: 8,  payloadCpuFactor: 0.5, label: 'Image resize' },
    hash_compute:    { cpuUnits: 16, ioMs: 4,  payloadCpuFactor: 0.3, label: 'Hash compute' },
    db_query:        { cpuUnits: 3,  ioMs: 30, payloadCpuFactor: 0.0, label: 'Database query' },
    report_generate: { cpuUnits: 28, ioMs: 20, payloadCpuFactor: 0.8, label: 'Report generation' },
    ml_inference:    { cpuUnits: 12, ioMs: 12, payloadCpuFactor: 0.4, label: 'ML inference' },
  },

  // ---- Shared cost model --------------------------------------------------
  // The SAME formula produces predicted and actual cost; only the input
  // milliseconds differ. That isolates ML prediction error as the sole source
  // of predicted-vs-actual divergence.
  costModel: {
    vcpuCount: Number(process.env.VCPU_COUNT || 1),
    memoryMB: Number(process.env.MEMORY_MB || 512),
    pricePerVcpuSec: 0.0000166667,   // USD per vCPU-second
    pricePerGbSec: 0.0000166667,     // USD per GB-second
    pricePerInvocation: 0.0000002,   // USD per invocation
    pricePerGbEgress: 0.09,          // USD per GB transferred out
    minBilledMs: 1,
  },

  // ---- Baseline gateway (traditional request-count / rate handling) -------
  baseline: {
    maxConcurrent: Number(process.env.BASELINE_MAX_CONCURRENT || 8),
    rateLimit: {
      enabled: true,
      capacity: 200,       // burst
      refillPerSec: 100,   // sustained admissions
    },
  },

  // ---- Predictive gateway -------------------------------------------------
  predictive: {
    maxConcurrent: Number(process.env.PREDICTIVE_MAX_CONCURRENT || 8),
    maxQueue: Number(process.env.PREDICTIVE_MAX_QUEUE || 32),
    // Two HTTP slots gave the best measured stress prediction throughput with
    // RF n_jobs=1. FastAPI retains its independent four-worker upper bound.
    mlConcurrency: Number(process.env.ML_CONCURRENCY || 2),
    predictionAdmission: {
      maxWaiting: Number(process.env.PREDICTION_MAX_WAITING ?? 4),
      normalWaitMs: Number(process.env.PREDICTION_NORMAL_WAIT_MS ?? 50),
      highWaitMs: Number(process.env.PREDICTION_HIGH_WAIT_MS ?? 100),
    },

    budget: {
      windowMs: 10_000,       // rolling budget window
      usdPerWindow: 0.001,    // allows ~500 requests/window; stress profile has 588
      cheapShare: 0.3,        // predicted cost <= cheapShare * remaining => cheap
    },

    utilization: {
      softPct: 65,            // above this, be conservative
      hardPct: 90,            // above this, reject unless cheap/high-value
    },

    downgrade: {
      enabled: true,
      cpuFactor: 0.25,        // reduced-precision CPU work
      ioFactor: 0.5,
    },

    delay: {
      enabled: true,
      maxWaitMs: 750,
      pollMs: 25,
    },

    rateLimit: {
      enabled: true,
      capacity: 300,
      refillPerSec: 150,
    },

    cache: {
      enabled: true,
      ttlMs: 30_000,
      maxEntries: 500,
    },
  },

  sla: {
    targetLatencyMs: Number(process.env.SLA_TARGET_MS || 250),
  },

  // ---- Workload simulator -------------------------------------------------
  simulator: {
    defaultProfile: 'mixed',
    profiles: {
      light: {
        arrivalRatePerSec: 8,
        typeWeights: { db_query: 0.5, image_resize: 0.25, hash_compute: 0.15, ml_inference: 0.1, report_generate: 0.0 },
      },
      normal: {
        arrivalRatePerSec: 25,
        typeWeights: { db_query: 0.3, image_resize: 0.25, hash_compute: 0.2, ml_inference: 0.15, report_generate: 0.1 },
      },
      burst: {
        arrivalRatePerSec: 80,
        typeWeights: { db_query: 0.2, image_resize: 0.25, hash_compute: 0.25, ml_inference: 0.15, report_generate: 0.15 },
      },
      heavy_tail: {
        arrivalRatePerSec: 45,
        typeWeights: { db_query: 0.15, image_resize: 0.2, hash_compute: 0.25, ml_inference: 0.1, report_generate: 0.3 },
      },
      mixed: {
        arrivalRatePerSec: 40,
        typeWeights: { db_query: 0.25, image_resize: 0.22, hash_compute: 0.22, ml_inference: 0.16, report_generate: 0.15 },
      },
      // Stress profiles designed to trigger predictive behaviors
      stress: {
        arrivalRatePerSec: 200,
        typeWeights: { db_query: 0.1, image_resize: 0.2, hash_compute: 0.3, ml_inference: 0.15, report_generate: 0.25 },
      },
      overload: {
        arrivalRatePerSec: 500,
        typeWeights: { db_query: 0.05, image_resize: 0.15, hash_compute: 0.35, ml_inference: 0.15, report_generate: 0.3 },
      },
      // Demo profile: tuned to show ALLOW, DELAY, DOWNGRADE, REJECT
      demo: {
        arrivalRatePerSec: 120,
        typeWeights: { db_query: 0.2, image_resize: 0.2, hash_compute: 0.25, ml_inference: 0.15, report_generate: 0.2 },
      },
    },
    priorityWeights: { low: 0.2, normal: 0.6, high: 0.2 },
    payloadBytes: { min: 256, max: 16384 },
    // Fraction of hot_keys: 0 = uniform ids, 1 = all requests hit the hot set.
    hotKeyBias: Number(process.env.HOT_KEY_BIAS || 0.7),
  },

  data: {
    totalItems: 100,
    hotKeys: 10,
  },

  // ---- Metrics ------------------------------------------------------------
  metrics: {
    sampleIntervalMs: 1000,
    latencyBucketsMs: [1, 2, 5, 10, 20, 35, 50, 75, 100, 150, 250, 400, 700, 1000, 2000, 5000],
  },
};

module.exports = config;
