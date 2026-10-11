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
