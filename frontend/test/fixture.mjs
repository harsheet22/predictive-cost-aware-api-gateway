export function fixture() {
  const baseline = { incoming: 8, processed: 8, rejected: 0, inFlight: 0, experiment: { runId: 'run-a', elapsedSec: 4 }, cost: { estimatedCloudCostUsd: .001 } };
  const predictive = { incoming: 8, processed: 2, rejected: 6, inFlight: 0, allowed: 1, downgraded: 1, delayed: 0, slaMet: 1,
    experiment: { runId: 'run-a', elapsedSec: 8 }, cost: { estimatedCloudCostUsd: .0003 },
    predictionGate: { submissions: 7, admissions: 6, rejections: 2, immediateRejections: 1, expirations: 1, attempts: 5, rejectionReasons: { prediction_queue_full: 1, prediction_queue_expired: 1 } },
    ml: { startedCount: 5, completedCount: 5, successCount: 3, fallbackCount: 1, failureCount: 1 },
    decisionEngine: { reached: 4, outcomes: { ALLOW: 2, DOWNGRADE: 1, DELAY: 0, REJECT: 1 }, reasons: [] },
    pipeline: { prePredictionRateRejections: 1, postDecisionFinalized: 4, postDecisionRejected: 2 },
    execution: { failures: 1, fullQualityCompleted: 1, reducedQualityCompleted: 1, cachedCompleted: 0 },
    latency: { exact: { count: 8, avg: 37.125, p50: 30.001, p95: 99.123, p99: 99.123 } } };
  return { runId: 'run-a', telemetryVersion: 1, validation: { sameRun: true, reconciled: true }, failures: { baseline: [], predictive: [] }, totalRequests: 8, durationSec: 5, seed: 42, profile: 'test', slaTargetMs: 250, baseline, predictive };
}
