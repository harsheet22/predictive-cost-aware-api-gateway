'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const readline = require('readline');
const { performance } = require('perf_hooks');
const { safeSink, validateDisk, validatePermissions } = require('./tracing-safety.cjs');

function bytesIn(directory) {
  let total = 0;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    // Never follow junctions/symlinks into unrelated directories.
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Unexpected link in capture directory');
    if (item.isDirectory()) total += bytesIn(file);
    else if (item.isFile()) total += fs.statSync(file).size;
  }
  return total;
}
// Injection is used only by service-free tests; the default invokes native tools.
function commandRunner(event, execute = execFile, now = () => performance.now(), timers = { setTimeout, clearTimeout }) {
  event = safeSink(event);
  return function command(executable, args, timeout = 15000, allowFailure = false) {
    event({ kind: 'command_start', executable, args, timeout });
    return new Promise((resolve, reject) => {
      const started = now(); let timedOut = false, timer, child, settled = false;
      const callback = (error, stdout = '', stderr = '') => {
        if (settled) return; settled = true;
        if (timer !== undefined) timers.clearTimeout(timer);
        const code = error?.code;
        const result = { executable, args, exitCode: error ? (typeof code === 'number' ? code : null) : 0,
          signal: error?.signal || null, spawnError: error?.syscall?.startsWith('spawn') ? { code, message: error.message } : null,
          errorCode: typeof code === 'string' ? code : null, timedOut, killed: Boolean(error?.killed || timedOut),
          timeoutMs: timeout, elapsedMs: now() - started, stdout, stderr };
        event({ kind: 'command_end', ...result });
        if ((error || timedOut) && !allowFailure) reject(Object.assign(new Error(`${executable} failed: ${stderr || stdout || error?.message || 'command timeout'}`), { result }));
        else resolve(result);
      };
      try {
        child = execute(executable, args, { windowsHide: true, maxBuffer: 4 * 1024 ** 2 }, callback);
        if (settled) return;
        timer = timers.setTimeout(() => {
          timedOut = true; event({ kind: 'command_timeout', executable, args, timeout });
          // Only this exact owned native command process; never runner/gateway/another recording.
          try { child.kill('SIGTERM'); } catch (error) { event({ kind: 'command_termination_failed', error: error.message }); }
        }, timeout);
      } catch (error) { callback(error); }
    });
  };
}
function windowsRuntime(event) {
  event = safeSink(event);
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const probe = spawn(path.join(system, 'WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'tracing-session-probe.ps1')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0, dead; const pending = new Map();
  const fail = error => { dead = error; for (const p of pending.values()) p.reject(error); pending.clear(); };
  probe.on('error', fail); probe.on('exit', () => fail(new Error('Read-only ETW probe exited')));
  probe.stdin.on('error', fail);
  probe.stderr.on('data', data => event({ kind: 'probe_stderr', text: data.toString() }));
  readline.createInterface({ input: probe.stdout }).on('line', line => {
    try {
      const response = JSON.parse(line), p = pending.get(response.id);
      if (p) { pending.delete(response.id); response.error ? p.reject(new Error(response.error)) : p.resolve(response.data); }
    } catch (error) { fail(error); }
  });
  function query(action, extra = {}) {
    if (dead) return Promise.reject(dead);
    return new Promise((resolve, reject) => {
      const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Probe timeout: ${action}`)); }, 5000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      probe.stdin.write(JSON.stringify({ id, action, ...extra }) + '\n', error => { if (error) fail(error); });
    });
  }
  const execute = commandRunner(event);
  return { captureVerified: false, cleanupVerified: false,
    command: (executable, ...args) => execute(path.join(system, executable), ...args),
    sessions: async () => { const value = (await query('sessions')).sessions; if (!Array.isArray(value)) throw new Error('Incomplete session snapshot'); return value; },
    disk: async directory => validateDisk(await query('disk', { path: directory })),
    permissions: async directory => validatePermissions(await query('permissions', { path: directory })),
    close: () => {
      probe.stdin.end();
      if (dead) return;
      const deadline = setTimeout(() => {
        event({ kind: 'probe_close_timeout', pid: probe.pid });
        try { probe.kill('SIGTERM'); } catch (error) { event({ kind: 'probe_termination_failed', error: error.message }); }
      }, 5000);
      deadline.unref(); probe.once('exit', () => clearTimeout(deadline));
    } };
}
module.exports = { bytesIn, windowsRuntime, commandRunner };
