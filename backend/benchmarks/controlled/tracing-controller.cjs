'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { fork, spawn } = require('child_process');
const { root, write } = require('./common.cjs');
const { loadSavedTrace } = require('./diagnostic.cjs');
const { safeSink, measured, validatePermissions, classifySessions, launchState, superviseWatchdog } = require('./tracing-safety.cjs');
const LIVE_CAPTURE_BLOCKERS = Object.freeze(['Netsh/logman reconciliation is unverified', 'Live WPR logger mapping is unverified', 'Named-stop ownership race has no verified atomic protection']);
function assertLiveCaptureReviewed() { if (LIVE_CAPTURE_BLOCKERS.length) throw new Error('Live capture blocked: ' + LIVE_CAPTURE_BLOCKERS.join('; ')); }

const TRACE = 'backend/experiments/controlled-benchmark-2026-10-11T05-42-31-156Z-19826f7e/traces/overload-42.json';
const FILE_HASH = '0b5fd16adda0997854d8d1063272b59ccee50399503a428e202847116f1eb1ff';
const REQUEST_HASH = '3800f59c247d331243145f325ba203490b41d45a37bbe3721cf7e4fe5871cd66';
const GiB = 1024 ** 3;
const LIMITS = Object.freeze({ windowMs: 90000, pollMs: 500, stopBytes: 2 * GiB,
  finalizationHeadroomBytes: 2 * GiB, minimumFreeBytes: GiB, initialFreeBytes: 5 * GiB, networkMaxMiB: 512 });
function within(parent, child) {
  const relative = path.win32.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
}
function parseController(argv) {
  let execute = false, outputParent = path.join(os.homedir(), 'Downloads/gateway-tcp-diagnostics');
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error('Duplicate controller option');
    seen.add(flag);
    if (flag === '--execute') execute = true;
    else if (flag === '--output-parent' && argv[i + 1] && !argv[i + 1].startsWith('--')) outputParent = path.resolve(argv[++i]);
    else throw new Error(`Unknown/missing controller option: ${flag}`);
  }
  if (!execute) throw new Error('Explicit --execute is required; controller is not a preflight-only command');
  outputParent = path.resolve(outputParent);
  if (within(root, outputParent)) throw new Error('Tracing output must be outside the repository to preserve runner integrity checks');
  return { outputParent };
}
function diagnosticCommand() {
  return [path.join(root, 'backend/benchmarks/controlled/run.cjs'), '--mode', 'diagnostic', '--experiment', 'A',
    '--arm', 'baseline', '--trace', TRACE, '--drain', '300', '--expected-trace-sha256', FILE_HASH];
}
function validateOriginal(saved) {
  if (saved.evidence.sourceFileSha256 !== FILE_HASH || saved.input.hash !== REQUEST_HASH ||
      saved.input.profile !== 'overload' || saved.input.seed !== 42 || saved.input.durationSec !== 60 || saved.input.requests.length !== 29938) {
    throw new Error('Original Overload/42 trace identity changed; no capture or replay permitted');
  }
}
function stopReason({ elapsedMs, bytes, freeBytes, networkBytes = 0, armFinished = false, disconnected = false }) {
  if (disconnected) return 'controller_disconnected';
  if (armFinished) return 'arm_finished';
  if (![elapsedMs, bytes, freeBytes, networkBytes].every(measured)) return 'observation_error';
  if (elapsedMs >= LIMITS.windowMs) return 'time_threshold';
  if (bytes >= LIMITS.stopBytes) return 'storage_threshold';
  if (networkBytes >= (LIMITS.networkMaxMiB - 32) * 1024 ** 2) return 'network_storage_threshold';
  if (freeBytes < LIMITS.minimumFreeBytes + LIMITS.finalizationHeadroomBytes) return 'free_space_guard';
  return null;
}
function identifyNetwork(before, after, name, file) {
  const matches = after.filter(s => s.name === name);
  if (before.some(s => s.name === name) || matches.length !== 1 ||
      path.win32.normalize(matches[0].file).toLowerCase() !== path.win32.normalize(file).toLowerCase()) throw new Error('Network ownership ambiguous');
  return matches[0];
}
function identifyCpu(before, after, instance, temp) {
  const matches = after.filter(s => s.name.includes(instance));
  if (!matches.length || matches.some(s => before.some(old => old.name === s.name) || !s.file || !within(temp, s.file))) {
    throw new Error('WPR ownership ambiguous: cannot associate every instance session with its private temporary directory');
  }
  return matches;
}
function ownership(expected, current) {
  const found = current.filter(s => s.name === expected.name);
  if (!found.length) return 'absent';
  if (found.length !== 1) return 'ambiguous';
  const actual = found[0];
  return ['handle', 'guid', 'file'].every(key => actual[key] === expected[key]) ? 'owned' : 'ambiguous';
}
function captureIssues(owned, current) {
  const expected = [...(owned.network ? [owned.network] : []), ...(owned.cpu?.sessions || [])];
  return expected.flatMap(session => {
    const state = ownership(session, current);
    if (state !== 'owned') return [{ session: session.name, issue: `capture_session_${state}` }];
    const actual = current.find(s => s.name === session.name);
    return ['eventsLost', 'logBuffersLost', 'realTimeBuffersLost'].filter(key => actual[key] > 0)
      .map(key => ({ session: session.name, issue: key, count: actual[key] }));
  });
}
async function stopOwned(owned, current, runtime, event) {
  event = safeSink(event);
  if (runtime.cleanupVerified !== true && (owned.network || owned.cpu)) {
    event({ kind: 'cleanup_blocked', error: 'Native cleanup mapping/ownership protection is not verified; manual review required' });
    return { blocked: true, failed: false };
  }
  const tasks = []; let blocked = false;
  if (owned.network) {
    const state = ownership(owned.network, current);
    event({ kind: 'network_ownership_check', state });
    if (state === 'owned') tasks.push(Promise.resolve().then(() => runtime.command('logman.exe', ['stop', owned.network.name, '-ets'])));
    else if (state === 'ambiguous') { blocked = true; event({ kind: 'cleanup_blocked', target: 'network', error: 'Ownership changed; no stop issued' }); }
  }
  if (owned.cpu) {
    const states = owned.cpu.sessions.map(s => ownership(s, current));
    const extra = current.some(s => s.name.includes(owned.cpu.instance) && !owned.cpu.sessions.some(old => old.name === s.name));
    if (!extra && states.every(s => s === 'owned')) tasks.push(Promise.resolve().then(() => runtime.command('wpr.exe', ['-stop', owned.cpu.file,
      'Bounded baseline TCP diagnostic', '-instancename', owned.cpu.instance], 120000)));
    else if (!extra && states.every(s => s === 'absent')) event({ kind: 'cpu_already_absent' });
    else { blocked = true; event({ kind: 'cleanup_blocked', target: 'cpu', error: 'Missing, replaced or additional instance sessions; no stop issued' }); }
  }
  const results = await Promise.allSettled(tasks);
  for (const result of results) if (result.status === 'rejected') event({ kind: 'stop_error', error: result.reason.message });
  return { blocked, failed: results.some(result => result.status === 'rejected') };
}

async function recoverOwned(ledger, runtime, event) {
  event = safeSink(event);
  try {
    const current = await runtime.sessions();
    const delta = classifySessions(ledger.before || [], current, ledger.owned || {});
    event({ kind: 'recovery_sessions', delta });
    const cleanup = await stopOwned(ledger.owned || {}, current, runtime, event);
    if (delta.some(x => x.ownership === 'unknown')) cleanup.blocked = true;
    return cleanup;
  } catch (error) { event({ kind: 'cleanup_blocked', error: error.message }); return { blocked: true, failed: true }; }
}
async function controller(argv) {
  const options = parseController(argv);
  if (process.platform !== 'win32') throw new Error('Windows-only controller');
  // No CLI override: a separately reviewed request-free capture must resolve these blockers.
  assertLiveCaptureReviewed();
  const saved = loadSavedTrace(path.join(root, TRACE)); validateOriginal(saved);
  fs.mkdirSync(options.outputParent, { recursive: true });
  const parent = fs.realpathSync(options.outputParent);
  if (within(root, parent)) throw new Error('Resolved tracing output is inside the repository');
  const directory = path.join(parent, `baseline-tcp-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`);
  fs.mkdirSync(directory);
  const journal = safeSink(value => fs.appendFileSync(path.join(directory, 'controller-events.jsonl'), JSON.stringify({ epochMs: Date.now(), ...value }) + '\n'));
  // Read-only permission check precedes sensitive evidence and capture startup.
  const { windowsRuntime } = require('./tracing-runtime.cjs');
  const preflight = windowsRuntime(journal);
  try { const permissions = validatePermissions(await preflight.permissions(directory)); journal({ kind: 'output_permissions', permissions }); }
  finally { preflight.close(); }
  fs.writeFileSync(path.join(directory, 'source-trace.json'), saved.bytes, { flag: 'wx' });
  write(path.join(directory, 'controller.json'), { controllerPid: process.pid, argv, directory, limits: LIMITS,
    sourceTrace: saved.evidence, command: [process.execPath, ...diagnosticCommand()],
    storageNotice: 'Stop triggers, not hard quotas; polling/command latency and finalization may exceed thresholds.' });
  const state = launchState(); let ledger = { before: [], owned: {} }, watchdog, log, watchdogLog, interrupted = false;
  let monitor, finished, recoveryStarted = false, evidenceFailed = false;
  const persist = (file, value) => {
    if (!safeSink(data => write(path.join(directory, file), data))(value)) evidenceFailed = true;
  };
  const sendStop = reason => { try { if (watchdog?.connected) watchdog.send({ kind: 'stop', reason }, error => {
    if (error) journal({ kind: 'watchdog_ipc_error', error: error.message });
  }); } catch (error) { journal({ kind: 'watchdog_ipc_error', error: error.message }); } };
  const onSignal = () => { interrupted = true; state.cancel(); journal({ kind: 'controller_signal', note: 'Replay/drain is not shortened' }); sendStop('controller_signal'); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const waitFor = kind => new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); watchdog.off('message', message); watchdog.off('exit', exit); watchdog.off('error', fail); watchdog.off('disconnect', exit); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); };
    const fail = error => { clean(); reject(error); };
    const exit = () => fail(new Error('Watchdog exited/disconnected before launch'));
    const cancel = () => fail(new Error('Launch cancelled by controller signal'));
    const message = value => {
      if (['stopping', 'stopped', 'startup_failed'].includes(value.kind)) fail(new Error(value.error || 'Capture unavailable'));
      else if (value.kind === kind) { clean(); resolve(); }
    };
    const timer = setTimeout(() => fail(new Error('Watchdog acknowledgment timeout')), 90000);
    watchdog.on('message', message); watchdog.once('exit', exit); watchdog.once('error', fail); watchdog.once('disconnect', exit); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  });
  try {
    watchdogLog = fs.openSync(path.join(directory, 'watchdog-process.log'), 'wx');
    watchdog = fork(path.join(__dirname, 'tracing-watchdog.cjs'), [directory], { cwd: root, detached: true,
      windowsHide: true, stdio: ['ignore', watchdogLog, watchdogLog, 'ipc'] });
    finished = new Promise(resolve => { watchdog.once('exit', (code, signal) => resolve({ code, signal })); watchdog.once('error', error => resolve({ error: error.message })); });
    monitor = superviseWatchdog(watchdog, state, async result => {
      recoveryStarted = true; journal({ kind: 'watchdog_failed', result, ledger });
      // An in-memory IPC ledger survives an exhausted disk. No benchmark process is touched.
      if (!ledger.owned.network && !ledger.owned.cpu) { journal({ kind: 'manual_review_required', error: 'No verified session ledger survived' }); return; }
      const runtime = windowsRuntime(journal);
      try { journal({ kind: 'recovery_result', result: await recoverOwned(ledger, runtime, journal) }); }
      finally { runtime.close(); }
    }, value => { ledger = value; }, journal);
    journal({ kind: 'watchdog_started', pid: watchdog.pid });
    await waitFor('ready');
    if (!state.canRequest(watchdog.connected) || journal.failed()) throw new Error('Capture/cancellation/evidence state prevents launch');
    validateOriginal(loadSavedTrace(path.join(root, TRACE)));
    log = fs.openSync(path.join(directory, 'benchmark-process.log'), 'wx');
    const authorization = waitFor('launch_authorized');
    watchdog.send({ kind: 'authorize_launch' }, error => { if (error) { state.update({ kind: 'watchdog_failed' }); sendStop('authorization_failed'); } });
    await authorization;
    if (!state.canLaunch(watchdog.connected) || journal.failed()) throw new Error('Capture no longer authorized; replay not launched');
    const benchmark = spawn(process.execPath, diagnosticCommand(), { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    journal({ kind: 'benchmark_started', pid: benchmark.pid });
    const outcome = await new Promise(resolve => { benchmark.once('error', error => resolve({ error: error.message })); benchmark.once('exit', (code, signal) => resolve({ code, signal })); });
    persist('benchmark-exit.json', outcome);
    sendStop('arm_finished');
    const watchOutcome = await finished; await monitor.recovery();
    persist('watchdog-exit.json', watchOutcome);
    process.exitCode = interrupted ? 130 : outcome.error || outcome.code !== 0 || watchOutcome.code !== 0 || recoveryStarted || evidenceFailed || journal.failed() ? 1 : 0;
  } catch (error) { journal({ kind: 'controller_error', error: error.stack }); throw error; }
  finally {
    state.cancel(); sendStop('controller_finally');
    if (finished) await finished;
    if (monitor) await monitor.recovery();
    for (const fd of [log, watchdogLog]) if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
  console.log(`Controller evidence: ${directory}`);
}
if (require.main === module) controller(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { TRACE, FILE_HASH, LIVE_CAPTURE_BLOCKERS, assertLiveCaptureReviewed, recoverOwned, LIMITS, parseController, diagnosticCommand, validateOriginal, within, stopReason,
  identifyNetwork, identifyCpu, ownership, captureIssues, stopOwned };
