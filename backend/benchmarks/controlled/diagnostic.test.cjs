'use strict';
// Service-free tests: orchestration always receives an injected fake arm runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sha } = require('./common.cjs');
const { loadSavedTrace } = require('./diagnostic.cjs');
const { parse, runDiagnostic } = require('./run.cjs');

function input() {
  const requests = [0, 5].map((arrivalOffsetMs, index) => ({ requestId: `fixture-${index}`, type: 'db_query',
    priority: 'normal', precision: 'full', payloadSize: 100, parameters: { iterations: 1200, itemId: index },
    clientId: 'fixture-client', arrivalOffsetMs, arrivalTs: '2000-01-01T00:00:00.000Z' }));
  return { profile: 'overload', seed: 42, durationSec: 60, requests, hash: sha(JSON.stringify(requests)) };
}
function fixture(t, value = input()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-diagnostic-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'trace.json');
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\r\n');
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  const argv = ['--mode', 'diagnostic', '--trace', file, '--experiment', 'A', '--arm', 'baseline', '--drain', '300'];
  return { directory, file, bytes, argv };
}

test('diagnostic accepts an unchanged saved trace and distinguishes file and request hashes', t => {
  const f = fixture(t), saved = loadSavedTrace(f.file);
  assert.deepEqual(saved.input, input());
  assert.deepEqual(saved.bytes, f.bytes);
  assert.equal(saved.evidence.sourcePath, fs.realpathSync(f.file));
  assert.equal(saved.evidence.sourceFileSha256, sha(f.bytes));
  assert.equal(saved.evidence.embeddedTraceHash, input().hash);
  assert.notEqual(saved.evidence.sourceFileSha256, saved.evidence.embeddedTraceHash);
  assert.equal(saved.evidence.requestCount, 2);
});

test('diagnostic rejects incorrect embedded hash', t => {
  const value = input(); value.hash = '0'.repeat(64);
  assert.throws(() => loadSavedTrace(fixture(t, value).file), /embedded hash mismatch/);
});

test('diagnostic rejects malformed JSON and missing files', t => {
  const f = fixture(t, '{');
  assert.throws(() => loadSavedTrace(f.file), /Invalid saved trace JSON/);
  assert.throws(() => loadSavedTrace(path.join(f.directory, 'missing.json')), { code: 'ENOENT' });
});

for (const [name, mutate] of [
  ['null root', () => null], ['unknown profile', value => { value.profile = 'invented'; }],
  ['invalid seed', value => { value.seed = 42.5; }], ['invalid duration', value => { value.durationSec = 0; }],
  ['missing requests', value => { delete value.requests; }], ['empty requests', value => { value.requests = []; }],
  ['duplicate IDs', value => { value.requests[1].requestId = value.requests[0].requestId; }],
  ['unordered offsets', value => { value.requests[0].arrivalOffsetMs = 10; }],
  ['outside horizon', value => { value.requests[1].arrivalOffsetMs = 60001; }],
  ['negative offset', value => { value.requests[0].arrivalOffsetMs = -1; }],
  ['invalid request type', value => { value.requests[0].type = 'invented'; }],
  ['invalid priority', value => { value.requests[0].priority = 'urgent'; }],
  ['invalid parameters', value => { value.requests[0].parameters = null; }],
  ['invalid iterations', value => { value.requests[0].parameters.iterations = -1; }],
  ['invalid payload', value => { value.requests[0].payloadSize = -1; }],
  ['invalid arrival timestamp', value => { value.requests[0].arrivalTs = 'invalid'; }],
]) {
  test(`diagnostic rejects ${name} before running an arm`, async t => {
    let value = input(); const replacement = mutate(value); if (replacement === null) value = null;
    if (value?.requests) value.hash = sha(JSON.stringify(value.requests));
    const f = fixture(t, value); let calls = 0;
    await assert.rejects(runDiagnostic(parse(f.argv), f.argv, async () => { calls++; },
      { outputParent: f.directory, hashFiles: () => assert.fail('validation must precede output/integrity scanning') }), /Invalid saved trace/);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(f.directory), ['trace.json']);
    assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  });
}

test('diagnostic CLI rejects unintended arms, experiments, overrides and duplicates', () => {
  const base = ['--mode', 'diagnostic', '--trace', 'fixture.json'];
  const options = parse(base);
  assert.equal(options.arm, 'baseline'); assert.equal(options.experiment, 'A');
  assert.equal(options.drainSec, 300); assert.equal(options.maxOutstanding, 16384);
  for (const extra of [
    ['--arm', 'predictive'], ['--arm', 'baseline,predictive'], ['--experiment', 'B'], ['--experiment', 'both'],
    ['--profiles', 'overload'], ['--seeds', '42'], ['--duration', '60'], ['--max-outstanding', '1'],
    ['--drain', '0'], ['--trace', 'another.json'], ['--mode', 'full'], ['--unknown', 'value'], ['--arm'],
  ]) assert.throws(() => parse([...base, ...extra]));
  assert.throws(() => parse(['--mode', 'diagnostic']));
  assert.throws(() => parse(['--mode', 'screen', '--trace', 'fixture.json']));
});

test('screen/full CLI defaults and matrix selection remain unchanged', () => {
  assert.deepEqual(parse([]), { mode: 'screen', durationSec: 1, drainSec: 300, seeds: [42],
    profiles: ['light', 'stress'], experiment: 'both', maxOutstanding: 16384 });
  const full = parse(['--mode', 'full', '--experiment', 'A', '--profiles', 'light,overload', '--seeds', '42,43', '--duration', '60']);
  assert.equal(full.mode, 'full'); assert.deepEqual(full.profiles, ['light', 'overload']);
  assert.deepEqual(full.seeds, [42, 43]); assert.equal(full.durationSec, 60);
});

test('diagnostic orchestration calls exactly one A/baseline arm and preserves original bytes and evidence', async t => {
  const f = fixture(t); const calls = [];
  const row = { experiment: 'A', profile: 'overload', seed: 42, arm: 'baseline', runId: 'fixture-run',
    result: { valid: true, checks: { completeObservation: true, timing: true, noRetries: true } } };
  const fake = async (...args) => { calls.push(args); return row; };
  const deps = { outputParent: f.directory, hashFiles: () => ({ fixture: 'unchanged' }) };
  const result = await runDiagnostic(parse(f.argv), f.argv, fake, deps);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], input()); assert.equal(calls[0][1], 'baseline'); assert.equal(calls[0][2], 'A');
  assert.equal(calls[0][3].drainSec, 300); assert.equal(calls[0].length, 5);
  assert.deepEqual(fs.readFileSync(path.join(result.directory, 'source-trace.json')), f.bytes);
  assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.directory, 'manifest.json')));
  assert.equal(manifest.sourceTrace.sourceFileSha256, sha(f.bytes)); assert.equal(manifest.python.notUsed, true);
  assert.equal(manifest.protocol.retries, 0); assert.equal(manifest.protocol.dispatchP99LimitMs, 20);
  assert.equal(manifest.protocol.traceRegenerated, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.directory, 'results.json'))), [row]);
  const second = await runDiagnostic(parse(f.argv), f.argv, fake, deps);
  assert.notEqual(result.directory, second.directory);
});

test('invalid diagnostic arm is retained, fails original gate and never retries', async t => {
  const f = fixture(t); let calls = 0;
  const row = { experiment: 'A', profile: 'overload', seed: 42, arm: 'baseline',
    result: { valid: false, checks: { completeObservation: false, timing: true, noRetries: true } } };
  await assert.rejects(runDiagnostic(parse(f.argv), f.argv, async () => { calls++; return row; },
    { outputParent: f.directory, hashFiles: () => ({}) }), { code: 'BENCHMARK_VALIDITY_FAILED' });
  assert.equal(calls, 1);
  const output = path.join(f.directory, fs.readdirSync(f.directory).find(name => name.startsWith('controlled-diagnostic-')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'results.json'))), [row]);
  assert.ok(fs.existsSync(path.join(output, 'runner-error.json')));
  assert.deepEqual(fs.readFileSync(f.file), f.bytes);
});

test('programmatic diagnostic option changes cannot launch another arm', async t => {
  const f = fixture(t); const options = { ...parse(f.argv), arm: 'predictive' };
  await assert.rejects(runDiagnostic(options, f.argv, () => assert.fail('must not launch')),
    /options differ/);
});


test('pinned file hash is checked on the consumed bytes before hashing outputs or launching',async t=>{
  const f=fixture(t), pinned=sha(f.bytes), value=input();value.seed=43;
  // Still a valid embedded request hash, but not the original source bytes.
  fs.writeFileSync(f.file,JSON.stringify(value));
  const argv=[...f.argv,'--expected-trace-sha256',pinned];let calls=0;
  await assert.rejects(runDiagnostic(parse(argv),argv,async()=>{calls++;},{outputParent:f.directory,hashFiles:()=>assert.fail('must reject before integrity/output')}),/source-file SHA-256 mismatch/);
  assert.equal(calls,0);assert.deepEqual(fs.readdirSync(f.directory),['trace.json']);
});
test('correct pinned source hash accepts the exact bytes and invalid pins are rejected',t=>{
  const f=fixture(t),pin=sha(f.bytes);
  assert.equal(loadSavedTrace(f.file,pin).evidence.sourceFileSha256,pin);
  assert.equal(parse([...f.argv,'--expected-trace-sha256',pin]).expectedTraceSha256,pin);
  assert.throws(()=>parse([...f.argv,'--expected-trace-sha256','bad']),/Invalid expected/);
});
