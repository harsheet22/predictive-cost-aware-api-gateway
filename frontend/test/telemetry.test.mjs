import test from 'node:test';
import assert from 'node:assert/strict';
import { selectExperiment, phaseRates, costComparison, costSamples, reconciliationIssues, format, gateReason } from '../src/telemetry.js';

import { fixture } from './fixture.mjs';

test('completed experiment selection has no live fallback and clears old results while running', () => {
  const run = fixture(); const live = { predictive: { incoming: 900, cost: { estimatedCloudCostUsd: 20 } } };
  assert.equal(selectExperiment(run), run);
  live.predictive.incoming = 0;
  assert.equal(selectExperiment(run).predictive.incoming, 8);
  assert.equal(selectExperiment(run, true), null);
  assert.equal(selectExperiment(null), null);
});
test('incoming and completed rates have different explicit time denominators', () => {
  const run = fixture(); const rates = phaseRates(run.predictive, run.durationSec);
  assert.equal(rates.incomingPerSec, 1.6);
  assert.equal(rates.completedPerSec, .25);
  assert.equal(rates.gateAdmittedPerSec, .75);
  assert.equal(rates.completionPercent, 25);
});
test('all stages reconcile with gate rejection, expiry, fallback, ML failure and execution failure', () => {
  assert.deepEqual(reconciliationIssues(fixture()), []);
});
test('missing telemetry and mismatched run IDs are visible instead of fabricated zeros', () => {
  assert.equal(phaseRates({}, 5).completedPerSec, null);
  assert.equal(format(undefined), '—');
  assert.equal(format(0), '0');
  assert.equal(gateReason(undefined, 'prediction_queue_full'), null);
  assert.equal(gateReason({ rejectionReasons: {} }, 'prediction_queue_full'), 0);
  const run = fixture(); run.predictive.experiment.runId = 'other-run';
  assert.ok(reconciliationIssues(run).length);
  delete run.predictive.decisionEngine;
  assert.ok(reconciliationIssues(run).some(issue => issue.startsWith('DecisionEngine')));
});
test('lower cost with fewer completions is disclosed as a difference, never savings', () => {
  const report = costComparison(fixture());
  assert.equal(report.label, 'Estimated cost difference');
  assert.equal(report.fewerCompleted, true);
  assert.equal(report.predictivePerCompleted, .00015);
});
test('savings require matching workload and completions; reduced quality is exposed', () => {
  const run = fixture(); run.predictive.processed = 8;
  assert.equal(costComparison(run).label, 'Estimated cost savings');
  assert.equal(costComparison(run).reduced, 1);
  run.predictive.cost.estimatedCloudCostUsd = .002;
  assert.equal(costComparison(run).label, 'Estimated cost increase');
  run.baseline.cost.estimatedCloudCostUsd = 0;
  assert.equal(costComparison(run).percent, null);
});
test('history uses timestamped samples from this comparison only', () => {
  const run = fixture(); run.baseline.costHistory = [{ timestamp: 1, phase: 'baseline', actualCostUsd: .001 }];
  run.predictive.costHistory = [{ timestamp: 2, phase: 'predictive', actualCostUsd: .0003, predictedCostUsd: .0005 }];
  assert.deepEqual(costSamples(run), [{ timestamp: 1, phase: 'baseline', baselineCost: .001 }, { timestamp: 2, phase: 'predictive', predictiveCost: .0003, predictedCost: .0005 }]);
});
