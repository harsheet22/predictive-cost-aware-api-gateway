'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { fork, spawn, execFile, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const { root, hashes, write, trace, summarize, stats } = require('./common.cjs');
const { parseDiagnostic, loadSavedTrace } = require('./diagnostic.cjs');
const allProfiles = ['light', 'normal', 'mixed', 'burst', 'heavy_tail', 'stress', 'overload', 'demo'];
function parse(argv) {
  if (argv.some((value, index) => index % 2 === 0 && value === '--mode' && argv[index + 1] === 'diagnostic')) return parseDiagnostic(argv);
  const options = { mode: 'screen', durationSec: 1, drainSec: 300, seeds: [42], profiles: ['light', 'stress'], experiment: 'both', maxOutstanding: 16384 };
  const flags = { '--duration': 'durationSec', '--drain': 'drainSec', '--mode': 'mode', '--profiles': 'profiles', '--seeds': 'seeds', '--experiment': 'experiment', '--max-outstanding': 'maxOutstanding' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]], value = argv[i + 1];
    if (!key || value == null) throw new Error(`Unknown/missing option ${argv[i]}`);
    options[key] = ['durationSec', 'drainSec', 'maxOutstanding'].includes(key) ? Number(value) : key === 'seeds' ? value.split(',').map(Number) : key === 'profiles' ? value.split(',') : value;
  }
  if (!['screen', 'full'].includes(options.mode) || !['A', 'B', 'both'].includes(options.experiment) ||
      !options.profiles.length || options.profiles.some(p => !allProfiles.includes(p)) || new Set(options.profiles).size !== options.profiles.length ||
      !options.seeds.length || options.seeds.some(s => !Number.isSafeInteger(s)) || new Set(options.seeds).size !== options.seeds.length ||
      !Number.isFinite(options.durationSec) || options.durationSec <= 0 || !Number.isFinite(options.drainSec) || options.drainSec < 0 ||
      !Number.isSafeInteger(options.maxOutstanding) || options.maxOutstanding < 1) throw new Error('Invalid benchmark options');
  if (options.mode === 'screen' && (options.durationSec > 5 || options.profiles.length > 3 || options.seeds.length > 1)) throw new Error('Screening is limited to ≤5 s, ≤3 profiles, one seed');
  return options;
}
const owned = new Set();
let aborted = false;
function own(child) { owned.add(child); child.on('exit', () => owned.delete(child)); return child; }
function request(child, message, kind, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${kind}`)), timeoutMs);
    function finish(error, data) { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); error ? reject(error) : resolve(data); }
    const onExit = (code, signal) => finish(new Error(`Child exited while waiting for ${kind}: ${code}/${signal}`));
    const onError = error => finish(error);
    const onMessage = value => { if (value.kind === kind) finish(null, value); else if (value.kind === 'clientError') finish(new Error(value.error)); };
    child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
    if (message) child.send(message);
  });
}
async function stop(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const done = new Promise(resolve => child.once('exit', resolve));
  if (process.platform === 'win32') {
    // Terminate only a process tree launched by this runner, including venv launchers.
    await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
  } else child.kill();
  await Promise.race([done, new Promise(resolve => setTimeout(resolve, 2000))]);
  if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
}
function forkFile(file, args, env, logs) {
  const child = own(fork(path.join(__dirname, file), args, { cwd: root, env, silent: true, windowsHide: true, serialization: 'advanced' }));
  child.stdout.on('data', chunk => logs.push(chunk.toString())); child.stderr.on('data', chunk => logs.push(chunk.toString()));
  return child;
}
async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function health(child, port) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) throw new Error('Owned ML process failed to start');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) { const data = await res.json(); if (!data.modelLoaded) throw new Error('RF model missing: fallback is not a valid screening run'); return data; }
    } catch (error) { if (error.message.startsWith('RF model')) throw error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('ML health timeout');
}
async function runArm(input, arm, experiment, options, directory, python) {
  const runId = randomUUID(), logs = [], mlLogs = [], resourceSamples = [];
  const diagnosticStartedAt = options.mode === 'diagnostic' ? new Date().toISOString() : undefined;
  const runDir = path.join(directory, 'runs', experiment, input.profile, String(input.seed), arm);
  let ml, mlPid, server, client, sampler, ready, mlHealth, serverData, clientData;
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  try {
    if (['predictive', 'policy', 'shadow'].includes(arm)) {
      const port = await freePort(); env.ML_SERVICE_URL = `http://127.0.0.1:${port}`;
      const entry = 'import os,sys; print("BENCH_ML_PID:"+str(os.getpid()),flush=True); import uvicorn; uvicorn.run("app.main:app",host="127.0.0.1",port=int(sys.argv[1]),access_log=False)';
      ml = own(spawn(python, ['-B', '-c', entry, String(port)],
        { cwd: path.join(root, 'ml-service'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
      ml.stdout.on('data', chunk => mlLogs.push(chunk.toString())); ml.stderr.on('data', chunk => mlLogs.push(chunk.toString()));
      mlHealth = await health(ml, port);
      const match = mlLogs.join('').match(/BENCH_ML_PID:(\d+)/);
      if (!match) throw new Error('Actual ML interpreter PID was not reported');
      mlPid = Number(match[1]);
      const requestBody = input.requests[0];
      if (requestBody) for (let i = 0; i < 3; i++) {
        const res = await fetch(`${env.ML_SERVICE_URL}/predict`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...requestBody, iterations: requestBody.parameters.iterations }), signal: AbortSignal.timeout(30000) });
        if (!res.ok || res.headers.get('x-prediction-fallback')) throw new Error('Warmup prediction failed/fell back');
        await res.json();
      }
    }
    server = forkFile('server.cjs', [arm], env, logs);
    ready = await request(server, null, 'ready');
    await request(server, { kind: 'begin', runId, traceHash: input.hash, durationSec: input.durationSec }, 'begun');
    if (ml) {
      const processIds = [...new Set([ml.pid, mlPid])];
      sampler = own(spawn(python, ['-B', path.join(__dirname, 'resource_sampler.py'), processIds.join(',')],
        { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
      let buffer = '';
      sampler.stdout.on('data', chunk => {
        buffer += chunk.toString(); let split;
        while ((split = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); if (line.trim()) resourceSamples.push(JSON.parse(line)); }
      });
      sampler.stderr.on('data', chunk => logs.push(chunk.toString()));
      // Obtain a first resource sample before the offered horizon starts.
      const deadline = Date.now() + 10000;
      while (!resourceSamples.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (!resourceSamples.length) throw new Error('ML resource sampler did not start');
    }
    client = forkFile('loadgen.cjs', [], env, logs);
    clientData = (await request(client, { input, port: ready.port, maxOutstanding: options.maxOutstanding,
      drainSec: options.drainSec, timeoutSec: 360 }, 'clientResult', (input.durationSec + options.drainSec + 60) * 1000)).data;
    serverData = (await request(server, { kind: 'snapshot' }, 'snapshot')).data;
    if (sampler) {
      const exited = new Promise(resolve => sampler.once('exit', resolve)); sampler.stdin.end('\n');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    const goodSamples = resourceSamples.filter(r => Number.isFinite(r.cpuSeconds));
    serverData.resources.ml = ml ? { launcherPid: ml.pid, interpreterPid: mlPid, samples: resourceSamples,
      cpuSeconds: goodSamples.length >= 2 ? goodSamples.at(-1).cpuSeconds - goodSamples[0].cpuSeconds : null,
      peakRssBytes: goodSamples.length ? Math.max(...goodSamples.map(r => r.rssBytes)) : null,
      sampledMeanRssBytes: goodSamples.length ? goodSamples.reduce((sum,r) => sum+r.rssBytes,0)/goodSamples.length : null,
      interval: 'first sampler observation before client launch through snapshot; startup/model warmup excluded',
      complete: goodSamples.length >= 2 && goodSamples.length === resourceSamples.length,
      processScope: 'actual uvicorn interpreter including threads, plus launcher if distinct; RSS sums may include shared pages' } : { notUsed: true, cpuSeconds: 0 };
    serverData.resources.node.interval = 'server begin before client launch through server snapshot; includes client startup/arming gap';
    const result = summarize(input, clientData, serverData);
    if (experiment === 'B') {
      result.checks.fullQuality = Object.keys(result.quality).every(key => key === 'full');
      result.checks.noReuseOrCache = serverData.rows.every(r => !r.execution?.cpuIterationsReused && !r.outcome?.cached);
      result.valid = result.valid && result.checks.fullQuality && result.checks.noReuseOrCache;
    }
    result.checks.resourceAccounting = !ml || serverData.resources.ml.complete;
    result.checks.noSilentFallback = serverData.snapshot.ml.fallbackCount === 0;
    result.valid &&= result.checks.resourceAccounting;
    result.valid &&= result.checks.noSilentFallback;
    const localEnv = Object.fromEntries(Object.entries(env).filter(([key]) => /^(ML_|BASELINE_|PREDICTIVE_|PREDICTION_|HASH_|SYNC_|LOW_PRIORITY_|SLA_|VCPU_|MEMORY_MB|HOT_KEY_)/.test(key)));
    write(path.join(runDir, 'config.json'), { runId, arm, experiment, config: ready.config, overrides: ready.overrides, environmentOverrides: localEnv,
      warmup: { mlDirectCalls: ml ? Math.min(3, input.requests.length ? 3 : 0) : 0, gatewayWarmup: 0, caches: 'cold', estimator: 'cold' }, mlHealth });
    write(path.join(runDir, 'client.json'), clientData); write(path.join(runDir, 'server.json'), serverData);
    write(path.join(runDir, 'result.json'), result);
    return { runId, experiment, profile: input.profile, seed: input.seed, arm, traceHash: input.hash,
      rawDirectory: path.relative(directory, runDir).replaceAll('\\', '/'), result };
  } finally {
    for (const child of [client, sampler, server, ml]) await stop(child);
    if (options.mode === 'diagnostic') write(path.join(runDir, 'processes.json'), {
      runId, arm, experiment, invocationStartedAt: diagnosticStartedAt,
      runnerPid: process.pid, gatewayPid: server?.pid, loadGeneratorPid: client?.pid,
      listener: ready ? { host: '127.0.0.1', port: ready.port } : null, mlStarted: Boolean(ml),
      gatewayExitCode: server?.exitCode, gatewaySignal: server?.signalCode,
      loadGeneratorExitCode: client?.exitCode, loadGeneratorSignal: client?.signalCode,
      capturedAfterOwnedProcessCleanupAt: new Date().toISOString(),
    });
    write(path.join(runDir, 'process.log'), logs.join('')); write(path.join(runDir, 'ml.log'), mlLogs.join(''));
  }
}
function report(results, options, integrity) {
  const value = n => n == null ? 'n/a' : typeof n === 'number' ? n.toFixed(2) : n;
  const lines = ['# Controlled benchmark infrastructure validation', '',
    `Mode: ${options.mode}. Duration ${options.durationSec} s; seeds ${options.seeds.join(', ')}. ${options.mode === 'screen' ? '**Screening only; full matrix was not launched. No efficacy conclusions.**' : 'Final paired observations; interpret only valid runs.'}`, '',
    '## Measured rows', '',
    '| Experiment / profile / seed | Arm | Valid | Offered / completed / rejected / failed / unresolved | Gateway successful mean / p50 / p95 / p99 ms | Client successful mean / p50 / p95 / p99 ms | Gateway SLA | Offered / completed incl. drain req/s | Synthetic USD / USD per completion |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of results) {
    const r = row.result, c = r.counts, g = r.latency.gatewaySuccessMs, t = r.latency.clientSuccessMs;
    lines.push(`| ${row.experiment}/${row.profile}/${row.seed} | ${row.arm} | ${r.valid} | ${c.offered}/${c.completed}/${c.rejected}/${c.failed}/${c.serverUnresolved} | ${[g.mean,g.p50,g.p95,g.p99].map(value).join(' / ')} | ${[t.mean,t.p50,t.p95,t.p99].map(value).join(' / ')} | ${r.sla.gatewayMet}/${r.sla.gatewayDenominator} | ${value(r.throughput.offeredPerSec)} / ${value(r.throughput.completedIncludingDrainPerSec)} | ${r.cost.totalUsd} / ${r.cost.perSuccessfulCompletionUsd ?? 'undefined'} |`);
  }
  lines.push('', '## Eight-profile coverage', '', '| Profile | A | B |', '| --- | --- | --- |');
  for (const profile of allProfiles) lines.push(`| ${profile} | ${results.some(r => r.profile === profile && r.experiment === 'A') ? 'Measured above' : 'Not measured in this pass'} | ${results.some(r => r.profile === profile && r.experiment === 'B') ? 'Measured above' : 'Not measured in this pass'} |`);
  lines.push('', '## Timing, counts and overhead', '');
  for (const row of results) {
    const r = row.result;
    lines.push(`- ${row.experiment}/${row.profile}/${row.seed}/${row.arm}: dispatch lateness p99 ${value(r.dispatchLatenessMs.p99)} ms; queue wait mean/p95 ${value(r.predictionQueueWaitMs.mean)}/${value(r.predictionQueueWaitMs.p95)} ms; HTTP ${value(r.httpMs.mean)} ms; RF ${value(r.inferenceMs.mean)} ms; budget wait ${value(r.budgetWaitMs.mean)} ms; execution queue wait ${value(r.executionQueueWaitMs.mean)} ms; quality ${JSON.stringify(r.quality)}; Node CPU ${value(r.resources.node.cpuSeconds)} s; Python CPU ${value(r.resources.ml.cpuSeconds)} s. Failed checks: ${Object.entries(r.checks).filter(([,ok]) => !ok).map(([key]) => key).join(', ') || 'none'}. Raw: [${row.rawDirectory}](${row.rawDirectory}/result.json).`);
  }
  lines.push('', '## Repeated-run variability', '');
  for (const experiment of ['A', 'B']) for (const profile of allProfiles) {
    const group = results.filter(r => r.experiment === experiment && r.profile === profile);
    for (const arm of new Set(group.map(r => r.arm))) {
      const rows = group.filter(r => r.arm === arm && r.result.valid);
      lines.push(`- ${experiment}/${profile}/${arm}: ${rows.length} valid run(s); ${rows.length < 2 ? 'repeatability unmeasured' : `successful gateway mean across runs ${JSON.stringify(stats(rows.map(r => r.result.latency.gatewaySuccessMs.mean)))}`}.`);
    }
  }
  lines.push('', '## Comparison interpretation and limitations', '',
    '- A is baseline versus current predictive bundle. Baseline uses a token bucket and nonqueueing execution guard; predictive has prediction/execution/budget buffering, Python overhead, CPU-prefix reuse and eligible reduced quality. Do not attribute bundle changes to ML alone.',
    '- B uses FIFO, shadow-prediction FIFO and full-quality policy arms. All have the same execution active/waiting capacities; shadow and policy share prediction buffering. Policy alone has budget waiting. FIFO→shadow includes prediction overhead AND extra buffering; shadow→policy includes cost/budget actuation, not unique Random Forest value.',
    '- Node/Python CPU is integrated over explicit observation intervals including client launch/arming gaps, not per-request CPU sums. ML startup/warmup and idle infrastructure are excluded here. RSS is sampled, not a complete memory-cost model.',
    '- SLA uses the resolved target, successful gateway results/server entries and successful client results/offers separately. Latencies above are successful-only; all terminal latency is retained in result.json. Open-loop dispatch lateness is reported independently.',
    '- No retries. Client timeout/transport failures and server requests unresolved at the cutoff are separate categories. Exceeding 20 ms p99 dispatch lateness invalidates timing claims; report the problem without changing admission policy.',
    '- Synthetic cost sums exclude ML, waiting/idle infrastructure and actual EC2 billing. No AWS savings claimed. Synthetic job outputs do not validate real application quality.',
    '- Screening cannot establish steady-state capacity, reliable p99 tails, repeated improvement or statistical significance. Unknown/unmeasured metrics remain null, not zero.',
    `- Protected file integrity: ${integrity.changed.length ? 'FAILED' : 'unchanged'}; checked ${integrity.count} paths against the pre-run content hashes.`,
    '', '## Next commands (require approval before execution)', '',
    'Run from the repository root. Each invocation creates a new timestamped output directory; no prior artifacts are overwritten.', '',
    '```powershell',
    'node backend/benchmarks/controlled/run.cjs --mode full --experiment A --profiles light,normal,mixed,burst,heavy_tail,stress,overload,demo --duration 60 --seeds 42,43,44 --drain 300',
    'node backend/benchmarks/controlled/run.cjs --mode full --experiment B --profiles light,normal,mixed,burst,heavy_tail,stress,overload,demo --duration 60 --seeds 42,43,44 --drain 300',
    '```', '', 'The runner owns fresh temporary-port gateway/ML processes and stops only those processes. Existing app ports are not used. Set BENCH_PYTHON to an existing compatible interpreter only if the default ml-service/.venv interpreter is unavailable.', '');
  return lines.join('\n');
}
function requireValidRun(row) {
  if (row.result.valid) return;
  const failed = Object.entries(row.result.checks).filter(([, ok]) => !ok).map(([name]) => name);
  const error = new Error(`Benchmark stopped after invalid run ${row.experiment}/${row.profile}/${row.seed}/${row.arm}: ${failed.join(', ') || 'validity failed'}. Raw observations retained; no further arms launched.`);
  error.code = 'BENCHMARK_VALIDITY_FAILED';
  throw error;
}
async function main(argv) {
  const options = parse(argv);
  if (options.mode === 'diagnostic') return runDiagnostic(options, argv);
  const before = hashes();
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const directory = path.join(root, 'backend/experiments', `controlled-benchmark-${stamp}-${randomUUID().slice(0,8)}`);
  fs.mkdirSync(directory, { recursive: false });
  write(path.join(directory, 'before-hashes.json'), before);
  const python = process.env.BENCH_PYTHON || path.join(root, 'ml-service/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const results = []; let error;
  try {
    const versions = JSON.parse(execFileSync(python, ['-B', '-c', 'import sys, json, fastapi, sklearn, numpy; print(json.dumps({"python":sys.version,"fastapi":fastapi.__version__,"sklearn":sklearn.__version__,"numpy":numpy.__version__}))'], { windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
    write(path.join(directory, 'manifest.json'), { benchmarkVersion: 1, argv, options, createdAt: new Date().toISOString(),
      node: process.version, python: versions, host: { os: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().map(c => c.model), memoryBytes: os.totalmem() },
      protocol: { warmupDirectHttpCalls: 3, freshProcessPerArm: true, retries: 0, dispatchP99LimitMs: 20, generatorSeparateProcess: true,
        resourceAllocation: 'same host, no imposed CPU affinity; execution slot counts in each config; Python included separately', order: 'balanced rotations across seeds/profiles; recorded per-run sequence' } });
    for (let index = 0; index < options.profiles.length; index++) for (let seedIndex = 0; seedIndex < options.seeds.length; seedIndex++) {
      const input = trace(options.profiles[index], options.seeds[seedIndex], options.durationSec);
      write(path.join(directory, 'traces', `${input.profile}-${input.seed}.json`), input);
      for (const experiment of options.experiment === 'both' ? ['A','B'] : [options.experiment]) {
        const original = experiment === 'A' ? ['baseline','predictive'] : ['fifo','shadow','policy'];
        const rotation = (index + seedIndex) % original.length;
        const order = original.slice(rotation).concat(original.slice(0, rotation));
        for (const arm of order) {
          if (aborted) throw new Error('Benchmark interrupted; no additional arms launched');
          console.log(`SCREEN=${options.mode === 'screen'} ${experiment}/${input.profile}/${input.seed}/${arm}`);
          const result = await runArm(input, arm, experiment, options, directory, python);
          results.push(result); console.log(`valid=${result.result.valid} lateness p99=${result.result.dispatchLatenessMs.p99?.toFixed(2)} ms`);
          requireValidRun(result);
        }
      }
    }
  } catch (caught) { error = caught; }
  finally {
    for (const child of [...owned]) await stop(child);
    const after = hashes(directory);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]);
    const integrity = { count: Object.keys(before).length, changed };
    write(path.join(directory, 'integrity.json'), integrity);
    write(path.join(directory, 'results.json'), results);
    if (error) write(path.join(directory, 'runner-error.json'), { error: error.stack });
    write(path.join(directory, 'REPORT.md'), report(results, options, integrity));
    console.log(`Report: ${path.join(directory, 'REPORT.md')}`);
    if (error) throw error;
    if (changed.length || results.some(row => !row.result.valid)) process.exitCode = 2;
  }
}
async function runDiagnostic(options, argv, executeArm = runArm, { outputParent = path.join(root, 'backend/experiments'), hashFiles = hashes } = {}) {
  // Revalidate even programmatic callers before touching output or launching a child.
  const checked = parseDiagnostic(argv);
  if (JSON.stringify(options) !== JSON.stringify(checked)) throw new Error('Diagnostic options differ from the explicit CLI selection');
  const saved = loadSavedTrace(options.tracePath, options.expectedTraceSha256);
  const before = hashFiles();
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const directory = path.join(outputParent, `controlled-diagnostic-${stamp}-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: false });
  fs.writeFileSync(path.join(directory, 'source-trace.json'), saved.bytes, { flag: 'wx' });
  write(path.join(directory, 'trace-evidence.json'), saved.evidence);
  write(path.join(directory, 'before-hashes.json'), before);
  write(path.join(directory, 'manifest.json'), { benchmarkVersion: 1, argv, options,
    createdAt: new Date().toISOString(), node: process.version, runnerPid: process.pid, python: { notUsed: true },
    host: { os: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().map(cpu => cpu.model), memoryBytes: os.totalmem() },
    sourceTrace: saved.evidence, protocol: { singleArm: 'A/baseline', traceRegenerated: false,
      freshProcessPerArm: true, retries: 0, dispatchP99LimitMs: 20, generatorSeparateProcess: true,
      drainSec: 300, maxOutstanding: 16384, clientTimeoutSec: 360 } });
  const results = []; let error;
  try {
    if (aborted) throw new Error('Diagnostic interrupted before launch');
    const result = await executeArm(saved.input, 'baseline', 'A', options, directory);
    results.push(result);
    requireValidRun(result);
  } catch (caught) { error = caught; }
  finally {
    const after = hashFiles(directory);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]);
    const integrity = { count: Object.keys(before).length, changed };
    write(path.join(directory, 'integrity.json'), integrity);
    write(path.join(directory, 'results.json'), results);
    if (error) write(path.join(directory, 'runner-error.json'), { error: error.stack });
    write(path.join(directory, 'REPORT.md'), ['# Single baseline diagnostic replay', '',
      `Source: ${saved.evidence.sourcePath}`, `File SHA-256: ${saved.evidence.sourceFileSha256}`,
      `Request trace hash: ${saved.input.hash}`, `Profile/seed/horizon: ${saved.input.profile}/${saved.input.seed}/${saved.input.durationSec} s`,
      'Exactly one A/baseline arm; no request regeneration, retries, Python or additional arms.',
      `Valid: ${results[0]?.result.valid ?? 'no completed arm'}`,
      `Failed checks: ${results.length ? Object.entries(results[0].result.checks).filter(([, ok]) => !ok).map(([key]) => key).join(', ') || 'none' : 'see runner-error.json'}`,
      `Protected file changes: ${changed.length}`, '',
      'Raw observations/configuration/process IDs are under runs/A; all outcomes and validity checks are retained.',
      'This is diagnostic evidence, not a paired comparison or a replacement for an earlier invalid run.', ''].join('\n'));
    console.log(`Diagnostic report: ${path.join(directory, 'REPORT.md')}`);
    if (error) throw error;
    if (changed.length) throw new Error('Diagnostic protected-file integrity check failed');
  }
  return { directory, results };
}
if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { aborted = true; for (const child of owned) stop(child); process.exitCode = 130; });
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { parse, report, requireValidRun, runDiagnostic };
