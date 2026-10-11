'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');
const { LIMITS, stopReason, identifyNetwork, identifyCpu, stopOwned, captureIssues, assertLiveCaptureReviewed } = require('./tracing-controller.cjs');
const { windowsRuntime, bytesIn } = require('./tracing-runtime.cjs');
const { safeSink, validateDisk, validatePermissions, classifySessions } = require('./tracing-safety.cjs');

async function watch(directory, deps = {}) {
  if (!deps.runtime) assertLiveCaptureReviewed();
  const io = deps.io || fs, host = deps.host || process, now = deps.now || (() => performance.now());
  const interval = deps.interval || setInterval, cancelInterval = deps.cancelInterval || clearInterval;
  const rawEvent = deps.event || (value => io.appendFileSync(path.join(directory, 'watchdog-events.jsonl'), JSON.stringify({ epochMs: Date.now(), monotonicMs: now(), ...value }) + '\n'));
  const event = safeSink(rawEvent, deps.fallback);
  const runtime = deps.runtime || windowsRuntime(event), id = randomUUID().replaceAll('-', '');
  const networkName = `GatewayNet${id}`, cpuInstance = `GatewayCPU${id}`;
  const networkFile = path.join(directory, 'network.etl'), cpuFile = path.join(directory, 'cpu.etl'), temp = path.join(directory, 'wpr-temp');
  const owned = {}; let before = [], preflightComplete = false, start, timer, polling = false, reason, startupDone = false, stopping, ready = false;
  let measurementFailed = false, lastSample, maxGapMs = 0, peakBytes = 0, latest;
  const send = message => { try { if (host.connected) host.send(message, error => { if (error) requestStop('controller_disconnected'); }); } catch { requestStop('controller_disconnected'); } };
  const save = () => {
    const ledger = { watchdogPid: host.pid, networkName, cpuInstance, networkFile, cpuFile, temp,
      before, preflightComplete, owned, startMonotonicMs: start, reason };
    send({ kind: 'ledger', ledger }); // Independent of journal/disk persistence.
    if (!safeSink(value => io.writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify(value, null, 2)), deps.fallback)(ledger)) {
      host.exitCode = 1; reason ||= 'evidence_write_failed'; return false;
    }
    return true;
  };
  async function sample(finalizing = false) {
    if (polling) { event({ kind: 'monitoring_gap', finalizing, error: 'Earlier observation still pending' }); return; }
    polling = true;
    try {
      const sampleAt = now(); if (lastSample !== undefined) maxGapMs = Math.max(maxGapMs, sampleAt - lastSample);
      const bytes = (deps.bytesIn || bytesIn)(directory), networkBytes = io.existsSync(networkFile) ? io.statSync(networkFile).size : 0;
      const disk = validateDisk(await runtime.disk(directory));
      latest = { bytes, networkBytes, freeBytes: disk.freeBytes, elapsedMs: now() - start };
      const trigger = stopReason(latest);
      if (trigger === 'observation_error') throw new Error('Invalid storage/time measurement');
      peakBytes = Math.max(peakBytes, bytes); maxGapMs = Math.max(maxGapMs, now() - (lastSample ?? start)); lastSample = now();
      if (!event({ kind: 'watch_sample', ...latest, volume: disk.volume, finalizing, sampleDurationMs: now() - sampleAt })) requestStop('evidence_write_failed');
      if (trigger && !stopping) requestStop(trigger);
    } catch (error) { measurementFailed = true; host.exitCode = 1; event({ kind: 'watch_error', finalizing, error: error.message }); if (!stopping) requestStop('observation_error'); }
    finally { polling = false; }
  }
  async function stop() {
    if (stopping) return stopping;
    ready = false; send({ kind: 'stopping', reason });
    stopping = Promise.resolve().then(async () => {
      event({ kind: 'stop_trigger', reason, elapsedMs: start == null ? null : now() - start }); save();
      try {
        const current = await runtime.sessions(); event({ kind: 'pre_stop_sessions', sessions: current });
        const delta = classifySessions(before, current, owned); event({ kind: 'session_delta', preflightComplete, delta });
        const issues = captureIssues(owned, current);
        if (issues.length || delta.some(x => x.ownership === 'unknown')) { event({ kind: 'capture_issues', issues, delta }); host.exitCode = 1; }
        const cleanup = await stopOwned(owned, current, runtime, event);
        if (cleanup.blocked || cleanup.failed) host.exitCode = 1;
        const after = await runtime.sessions(); event({ kind: 'post_stop_sessions', sessions: after });
        const remaining = classifySessions(before, after, owned);
        if (remaining.length) { event({ kind: 'manual_review_required', sessions: remaining }); host.exitCode = 1; }
      } catch (error) { event({ kind: 'cleanup_blocked', error: error.message }); host.exitCode = 1; }
      finally {
        if (start !== undefined) await sample(true);
        cancelInterval(timer);
        const elapsedMs = start === undefined ? null : now() - start;
        event({ kind: 'finalization_observation', elapsedMs,
          timeOvershootMs: elapsedMs === null ? null : Math.max(0, elapsedMs - LIMITS.windowMs),
          storageOvershootBytes: Math.max(0, peakBytes - LIMITS.stopBytes),
          latest, peakBytes, maxGapMs: Math.max(maxGapMs, lastSample === undefined || start === undefined ? 0 : now() - lastSample),
          monitoringIncomplete: measurementFailed || polling || lastSample === undefined, externalSymbolCacheBytes: 'not measured' });
        try { runtime.close(); } catch (error) { event({ kind: 'probe_close_failed', error: error.message }); host.exitCode = 1; }
        save(); if (event.failed()) host.exitCode = 1;
        host.off('message', messageHandler); host.off('disconnect', disconnectHandler);
        for (const signal of ['SIGINT', 'SIGTERM']) host.off(signal, signalHandler);
        send({ kind: 'stopped', reason }); if (host.connected) host.disconnect();
      }
    });
    return stopping;
  }
  function requestStop(value) { reason ||= value; ready = false; sendStopping(); if (startupDone) void stop().catch(error => { host.exitCode = 1; event({ kind: 'stop_failed', error: error.message }); }); }
  function sendStopping() { if (host.connected) { try { host.send({ kind: 'stopping', reason }, () => {}); } catch {} } }
  const messageHandler = message => {
    if (message.kind === 'stop') requestStop(message.reason);
    if (message.kind === 'authorize_launch') void (async () => {
      try {
        if (!ready || reason || stopping || event.failed() || now() - start >= LIMITS.windowMs - 60000) throw new Error('Capture cannot authorize launch');
        const current = await runtime.sessions();
        if (captureIssues(owned, current).length || classifySessions(before, current, owned).some(x => x.ownership === 'unknown')) throw new Error('Capture identity changed');
        const disk = validateDisk(await runtime.disk(directory));
        if (stopReason({elapsedMs: now()-start, bytes: (deps.bytesIn || bytesIn)(directory), freeBytes: disk.freeBytes})) throw new Error('Capture limits prevent launch');
        if (!ready || reason || stopping) throw new Error('Capture stopping');
        send({ kind: 'launch_authorized' });
      } catch (error) { event({ kind: 'launch_blocked', error: error.message }); requestStop('launch_blocked'); }
    })();
  };
  const disconnectHandler = () => requestStop('controller_disconnected');
  const signalHandler = () => requestStop('watchdog_signal');
  host.on('message', messageHandler); host.on('disconnect', disconnectHandler);
  for (const signal of ['SIGINT', 'SIGTERM']) host.on(signal, signalHandler);
  try {
    io.mkdirSync(temp);
    validatePermissions(await runtime.permissions(directory));
    if (runtime.captureVerified !== true) throw new Error('Live capture mapping/cleanup remains blocked');
    before = await runtime.sessions(); preflightComplete = true; save(); event({ kind: 'preflight_sessions', sessions: before });
    if (before.some(s => /WPR_|NT Kernel Logger|NetTrace|GatewayNet|GatewayCPU/i.test(s.name))) throw new Error('Potentially conflicting recording is active; none will be stopped');
    const netStatus = await runtime.command('netsh.exe', ['trace', 'show', 'status'], 15000, true);
    if (!/no trace session.*(?:progress|running)/i.test(netStatus.stdout + netStatus.stderr)) throw new Error('Network inactivity cannot be verified (English status required)');
    const wprStatus = await runtime.command('wpr.exe', ['-status'], 15000, true);
    if (!/no trace profiles running/i.test(wprStatus.stdout + wprStatus.stderr)) throw new Error('WPR inactivity cannot be verified (English status required)');
    for (const provider of ['Microsoft-Windows-TCPIP', 'Microsoft-Windows-Winsock-AFD']) {
      await runtime.command('netsh.exe', ['trace', 'show', 'provider', `name=${provider}`]);
      // Retain local event schemas; a missing manifest blocks dispatch rather than guessing coverage.
      await runtime.command('wevtutil.exe', ['gp', provider, '/ge:true']);
    }
    const profile = await runtime.command('wpr.exe', ['-profiledetails', 'CPU.light']);
    if (!/CSwitch/i.test(profile.stdout) || !/ReadyThread/i.test(profile.stdout) || !/SampledProfile|Profile/i.test(profile.stdout)) throw new Error('CPU.light scheduling coverage could not be verified');
    const disk = validateDisk(await runtime.disk(directory)); event({ kind: 'initial_disk', ...disk });
    if (disk.freeBytes < LIMITS.initialFreeBytes) throw new Error('At least 5 GiB free is required before capture');
    if (reason || event.failed()) throw new Error('Capture cancelled before startup');
    start = now(); if (!save()) throw new Error('Ownership ledger write failed');
    timer = interval(() => {
      if (now() - start >= LIMITS.windowMs && !stopping) requestStop('time_threshold');
      void sample(Boolean(stopping));
    }, LIMITS.pollMs);
    // Only named network session stop is used; never the global `netsh trace stop`.
    await runtime.command('netsh.exe', ['trace', 'start', `sessionname=${networkName}`, 'capture=no', 'report=no', 'persistent=no',
      `tracefile=${networkFile}`, `maxsize=${LIMITS.networkMaxMiB}`, 'filemode=single', 'overwrite=no',
      'provider=Microsoft-Windows-TCPIP', 'level=5', 'keywords=0xffffffffffffffff',
      'provider=Microsoft-Windows-Winsock-AFD', 'level=5', 'keywords=0xffffffffffffffff']);
    owned.network = identifyNetwork(before, await runtime.sessions(), networkName, networkFile); save();
    if (reason) throw new Error('Watchdog stop threshold reached during network startup');
    await runtime.command('wpr.exe', ['-start', 'CPU.light', '-filemode', '-recordtempto', temp, '-instancename', cpuInstance]);
    owned.cpu = { instance: cpuInstance, file: cpuFile, sessions: identifyCpu(before, await runtime.sessions(), cpuInstance, temp) }; save();
    if (reason || now() - start > LIMITS.windowMs - 60000) throw new Error('Insufficient remaining capture window; replay not launched');
    if (event.failed()) throw new Error('Capture evidence writes failed');
    startupDone = true; ready = true;
    if (!event({ kind: 'ready', owned })) throw new Error('Capture readiness could not be recorded');
    if (!host.connected) requestStop('controller_disconnected');
    else send({ kind: 'ready' });
  } catch (error) {
    event({ kind: 'startup_failed', error: error.message }); host.exitCode = 1;
    // Recover only uniquely named/path-associated sessions after partial startup.
    try {
      const current = await runtime.sessions();
      event({ kind: 'partial_startup_sessions', sessions: current, before, preflightComplete });
      if (!owned.network && current.some(s => s.name === networkName)) owned.network = identifyNetwork(before, current, networkName, networkFile);
      if (!owned.cpu && current.some(s => s.name.includes(cpuInstance))) owned.cpu = { instance: cpuInstance, file: cpuFile,
        sessions: identifyCpu(before, current, cpuInstance, temp) };
      event({ kind: 'session_delta', preflightComplete, delta: classifySessions(before, current, owned) }); save();
    } catch (error) { event({ kind: 'ownership_ambiguous', error: error.message }); }
    startupDone = true; reason ||= 'startup_failed';
    send({ kind: 'startup_failed', error: error.message });
    await stop();
  } finally {
    // On the normal ready path, handlers must remain until the eventual stop.
    if (stopping) { host.off('message', messageHandler); host.off('disconnect', disconnectHandler);
      for (const signal of ['SIGINT', 'SIGTERM']) host.off(signal, signalHandler); }
  }
  return { stop: reason => { requestStop(reason); return stopping; } };
}
if (require.main === module) watch(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { watch };
