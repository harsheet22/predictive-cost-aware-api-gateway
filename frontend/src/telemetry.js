export const number = value => Number.isFinite(value) ? value : null;
export const format = (value, digits = 0) => Number.isFinite(value) ? value.toFixed(digits) : '—';
export const ratio = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : null;

// Experiment cards deliberately have no live-metrics fallback.
export function selectExperiment(comparison, running = false) {
  return running ? null : comparison;
}

export function phaseRates(snapshot, configuredSeconds) {
  const elapsed = number(snapshot?.experiment?.elapsedSec);
  return {
    elapsedSec: elapsed,
    incomingPerSec: ratio(snapshot?.incoming, configuredSeconds),
    completedPerSec: ratio(snapshot?.processed, elapsed),
    gateAdmittedPerSec: ratio(snapshot?.predictionGate?.admissions, elapsed),
    completionPercent: ratio(snapshot?.processed, snapshot?.incoming) == null ? null : 100 * snapshot.processed / snapshot.incoming,
  };
}

export function costComparison(run) {
  const b = run?.baseline; const p = run?.predictive;
  const baselineCost = number(b?.cost?.estimatedCloudCostUsd);
  const predictiveCost = number(p?.cost?.estimatedCloudCostUsd);
  const difference = baselineCost != null && predictiveCost != null ? baselineCost - predictiveCost : null;
  const percent = ratio(difference, baselineCost);
  const sameWorkload = Boolean(run?.runId && run?.validation?.sameRun && run?.validation?.reconciled &&
    b?.incoming === run.totalRequests && p?.incoming === run.totalRequests);
  const sameCompletions = Number.isFinite(b?.processed) && b.processed === p?.processed;
  return {
    baselineCost, predictiveCost, difference, percent: percent == null ? null : percent * 100,
    label: difference < 0 ? 'Estimated cost increase' : difference > 0 && sameWorkload && sameCompletions ? 'Estimated cost savings' : 'Estimated cost difference',
    comparable: sameWorkload && sameCompletions,
    baselinePerCompleted: ratio(baselineCost, b?.processed),
    predictivePerCompleted: ratio(predictiveCost, p?.processed),
    reduced: number(p?.execution?.reducedQualityCompleted),
    fewerCompleted: Number.isFinite(b?.processed) && Number.isFinite(p?.processed) && p.processed < b.processed,
  };
}

export function costSamples(run) {
  return [
    ...(run?.baseline?.costHistory ?? []).map(s => ({ timestamp: s.timestamp, phase: s.phase, baselineCost: s.actualCostUsd })),
    ...(run?.predictive?.costHistory ?? []).map(s => ({ timestamp: s.timestamp, phase: s.phase, predictiveCost: s.actualCostUsd, predictedCost: s.predictedCostUsd })),
  ].sort((a, b) => a.timestamp - b.timestamp);
}

export function gateReason(gate, reason) {
  return gate?.rejectionReasons && typeof gate.rejectionReasons === 'object' ? gate.rejectionReasons[reason] ?? 0 : null;
}

export function reconciliationIssues(run) {
  if (!run) return [];
  const issues = [];
  const check = (known, valid, text) => { if (!known || !valid) issues.push(text); };
  check(run.telemetryVersion === 1, run.validation?.sameRun && run.validation?.reconciled, 'Run identity or terminal request accounting is missing or inconsistent.');
  for (const name of ['baseline', 'predictive']) {
    const s = run[name];
    check(s != null, s?.experiment?.runId === run.runId && s?.incoming === run.totalRequests, `${name}: snapshot does not match this workload/run.`);
    check(s != null, s?.incoming === s?.processed + s?.rejected + s?.inFlight, `${name}: incoming does not reconcile with completed, rejected and in-flight.`);
  }
  const s = run.predictive; const g = s?.predictionGate; const ml = s?.ml; const de = s?.decisionEngine;
  check(g != null, s?.incoming === s?.pipeline?.prePredictionRateRejections + g?.submissions, 'Predictive: incoming does not reconcile with the rate limiter and gate.');
  check(g != null, g?.submissions === g?.admissions + g?.immediateRejections, 'Gate: submissions do not reconcile with admissions and immediate rejection.');
  check(g != null, g?.admissions === g?.attempts + g?.expirations, 'Gate: admitted requests do not reconcile with predictions started and queue expiry.');
  check(ml != null, ml?.startedCount === ml?.completedCount && ml?.completedCount === ml?.successCount + ml?.failureCount + ml?.fallbackCount, 'ML: starts, completed attempts, failures or fallbacks do not reconcile.');
  check(de != null, de?.reached === ml?.successCount + ml?.fallbackCount && de?.reached === Object.values(de?.outcomes ?? {}).reduce((a, b) => a + b, 0), 'DecisionEngine: usable predictions and first policy outcomes do not reconcile.');
  check(de != null, de?.reached === s?.pipeline?.postDecisionFinalized, 'DecisionEngine: requests remain unfinished after reaching cost policy.');
  check(g != null, s?.rejected === s?.pipeline?.prePredictionRateRejections + g?.rejections + ml?.failureCount + s?.pipeline?.postDecisionRejected, 'Predictive: final rejection stages do not reconcile.');
  check(s?.execution != null, s?.execution?.fullQualityCompleted + s?.execution?.reducedQualityCompleted === s?.processed, 'Execution: quality completion counts are missing or inconsistent.');
  if (!s?.latency?.exact) issues.push('Exact gateway latency samples are unavailable (legacy telemetry or sample limit reached).');
  if (Object.values(run.failures ?? {}).some(rows => rows.length)) issues.push('The comparison runner recorded unhandled request failures.');
  return issues;
}
