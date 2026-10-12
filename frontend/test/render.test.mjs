import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.mjs';

test('actual dashboard components render policy-only counts, explicit denominators and honest cost', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { ExperimentResults } = await server.ssrLoadModule('/src/components/ExperimentResults.jsx');
    const html = renderToStaticMarkup(React.createElement(ExperimentResults, { comparison: fixture() }));
    for (const label of ['DecisionEngine Outcomes', 'Prediction Admission Gate', '50.0', '25.0', '99.123', '1 / 2', 'Estimated cost difference', 'Reduced-quality completions', 'run-a']) assert.ok(html.includes(label), label);
    assert.ok(!html.includes('Telemetry discrepancies'));
    assert.ok(!html.includes('Estimated cost savings'));
    const { ExternalLoadPanel } = await server.ssrLoadModule('/src/components/ExternalLoadPanel.jsx');
    const panel = renderToStaticMarkup(React.createElement(ExternalLoadPanel, { onResult: () => {}, onActive: () => {} }));
    assert.ok(panel.includes('Copy laptop command'));
    assert.ok(panel.includes('--rates 10,25,50'));
    assert.ok(panel.includes('Waiting for laptop traffic'));
    assert.ok(panel.includes('No automatic retries'));
    const external = fixture(); external.source = 'external';
    const arm = { valid: true, counts: { offered: 8, dispatched: 8, completed: 8, rejected: 0, failed: 0, transportErrors: 0 },
      latency: { clientSuccessMs: { mean: 61, p50: 50, p95: 95, p99: 100 } }, throughput: { completedIncludingDrainPerSec: 2 },
      sla: { clientMet: 8, offeredDenominator: 8 }, dispatchLatenessMs: { p99: 3 }, checks: { timing: true }, resources: { node: { cpuSeconds: .2, peakRssBytes: 1048576 } } };
    external.external = { configuredRate: 10, traceHash: 'trace-hash', baseline: arm, predictive: arm, limitations: ['ML is shared'] };
    const externalHtml = renderToStaticMarkup(React.createElement(ExperimentResults, { comparison: external }));
    for (const label of ['External Request Evidence', 'Transport errors', 'Client SLA', 'Dispatch lateness p99', 'Excludes parent proxy and Python', 'External comparison']) assert.ok(externalHtml.includes(label), label);
    assert.ok(!html.includes('Request Flow'));
    assert.ok(!html.includes('<table'));
    assert.ok(html.includes('Experiment Throughput'));
    assert.ok(html.includes('Decision Breakdown'));
    assert.ok(html.includes('Gateway Performance'));
    assert.ok(html.includes('<details class="card diagnostics"><summary>Advanced Diagnostics</summary>'));
    assert.equal((html.match(/class="metrics-row"/g) || []).length, 1, 'only the four summary cards remain as a headline card row');
    const cleared = renderToStaticMarkup(React.createElement(ExperimentResults, { comparison: fixture(), running: true }));
    assert.ok(cleared.includes('Previous experiment results have been cleared'));
    assert.ok(!cleared.includes('run-a'));
    const unknown = fixture(); delete unknown.predictive.decisionEngine; delete unknown.predictive.latency.exact;
    assert.ok(renderToStaticMarkup(React.createElement(ExperimentResults, { comparison: unknown })).includes('Telemetry discrepancies'));
  } finally { await server.close(); }
});
