'use strict';
const http = require('http');
const { performance, monitorEventLoopDelay, PerformanceObserver } = require('perf_hooks');
const { BenchmarkAgent, transportObserver, agentConfig } = require('./http-transport.cjs');
function scheduleAbsolute({ requests, start, dispatch, now = () => performance.now(), setTimer = setTimeout,
  defer = setImmediate, wakeups = [] }) {
  let next = 0;
  return new Promise(resolve => {
    function pump(expectedOffsetMs) {
      const entered = now(); const first = next;
      // Re-read the clock after every submission. A synchronous HTTP operation
      // can make additional arrivals due while this callback is still running.
      while (next < requests.length && requests[next].arrivalOffsetMs <= now() - start) {
        dispatch(requests[next], next); next++;
      }
      const finished = now();
      wakeups.push({ expectedOffsetMs, enteredMs: entered - start, finishedMs: finished - start,
        workMs: finished - entered, dispatched: next - first });
      if (next === requests.length) { resolve(); return; }
      scheduleNext();
    }
    function scheduleNext() {
      if (next === requests.length) { resolve(); return; }
      const target = requests[next].arrivalOffsetMs;
      const remaining = start + target - now();
      // Never send already-due work through setTimeout(0), which Node converts
      // to a nonzero timer wait. Preserve the same absolute deadlines and order.
      if (remaining <= 0) defer(() => pump(target));
      else setTimer(() => pump(target), remaining);
    }
    scheduleNext();
  });
}
async function load({ input, port, maxOutstanding = 16384, drainSec = 300, timeoutSec = 360 }) {
  const agent = new BenchmarkAgent(maxOutstanding);
  const rows = []; const pending = new Set();
  // Absolute deadlines prevent gateway completion or previous timer delays from
  // pacing subsequent arrivals. One finite capacity bound, no retries.
  const start = performance.now() + 100;
  const epochStartMs = Date.now() + 100;
  const transport = transportObserver(() => performance.now() - start);
  const cpuStart = process.cpuUsage();
  // Prepare identical wire bytes inside the existing 100 ms arming interval,
  // before arrivals become due. Do not reset start if preparation is slow.
  const payloads = input.requests.map(request => Buffer.from(JSON.stringify(request)));
  const wakeups = [], gcEvents = [];
  const delay = monitorEventLoopDelay({ resolution: 1 }); delay.enable();
  const gc = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (entry.startTime >= start && entry.startTime <= start + input.durationSec * 1000) {
      gcEvents.push({ startMs: entry.startTime - start, durationMs: entry.duration, kind: entry.detail.kind });
    }
  });
  gc.observe({ entryTypes: ['gc'] });
  await scheduleAbsolute({ requests: input.requests, start, wakeups,
    dispatch(request, index) {
        const row = { requestId: request.requestId, scheduledMs: request.arrivalOffsetMs, attempts: 0, dispatchMs: null };
        rows.push(row);
        if (pending.size >= maxOutstanding) { row.capacityMiss = true; return; }
        row.dispatchMs = performance.now() - start; row.dispatchEpochMs = Date.now(); row.attempts = 1;
        const payload = payloads[index];
        const req = http.request({ hostname: '127.0.0.1', port, path: '/execute', method: 'POST', agent,
          headers: { 'content-type': 'application/json', 'content-length': payload.length } });
        pending.add(req);
        const timeout = setTimeout(() => req.destroy(new Error('client_deadline')), timeoutSec * 1000);
        function finish() { clearTimeout(timeout); row.responseMs = performance.now() - start; pending.delete(req); }
        req.on('socket', socket => { row.socketAssignedMs = performance.now() - start;
          row.reusedSocket = req.reusedSocket;
          row.socketId = transport.assign(socket, request.requestId, { reusedSocket: req.reusedSocket });
          if (socket.connecting) socket.once('connect', () => { row.connectedMs = performance.now() - start; }); });
        req.on('response', res => {
          let body = ''; row.httpStatus = res.statusCode;
          row.responseConnection = res.headers.connection; row.responseKeepAlive = res.headers['keep-alive'];
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            try { row.outcome = JSON.parse(body); } catch { row.transportError = 'invalid_response_json'; }
            finish();
          });
          res.on('error', error => { row.transportError = error.message; row.transportErrorCode = error.code; finish(); });
          res.on('aborted', () => { row.transportError = 'response_aborted'; finish(); });
        });
        req.on('error', error => { row.transportError = error.message; row.transportErrorCode = error.code;
          row.reusedSocket = req.reusedSocket; finish(); });
        req.on('close', () => { row.requestCloseMs = performance.now() - start; });
        req.end(payload);
        row.submissionEndMs = performance.now() - start;
    },
  });
  delay.disable();
  const loopDelay = { scope: 'arming through last scheduled dispatch callback', n: delay.count,
    p99Ms: delay.count ? delay.percentile(99) / 1e6 : null, maxMs: delay.count ? delay.max / 1e6 : null };
  const deadline = start + (input.durationSec + drainSec) * 1000;
  while (performance.now() < start + input.durationSec * 1000 || (pending.size && performance.now() < deadline)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const unresolvedAtCutoff = [...pending].length;
  for (const req of pending) req.destroy(new Error('drain_cutoff'));
  await new Promise(resolve => setImmediate(resolve));
  transport.events.push({ kind:'agent_destroy', atMs:performance.now()-start, epochMs:Date.now() });
  agent.destroy();
  await new Promise(resolve => setImmediate(resolve));
  gc.disconnect();
  const cpu = process.cpuUsage(cpuStart);
  return { rows, traceHash: input.hash, epochStartMs, elapsedMs: performance.now() - start,
    unresolvedAtCutoff, maxOutstanding, timeoutSec, drainSec,
    resources: { cpuSeconds: (cpu.user + cpu.system) / 1e6, rssBytes: process.memoryUsage().rss },
    transport: { agent: agentConfig(agent), sockets: transport.sockets, events: transport.events,
      clock: 'client monotonic milliseconds relative to absolute arrival start; epochMs for coarse cross-process correlation' },
    scheduler: { version: 2, absoluteStartUnchanged: true, wakeups, eventLoopDelay: loopDelay, gcEvents,
      preparation: 'wire payloads encoded in the existing arming interval, without shifting start' },
    timingBoundary: 'monotonic dispatch through complete response; scheduled latency separately' };
}
if (require.main === module) {
  process.once('message', async options => {
    try { process.send({ kind: 'clientResult', data: await load(options) }, () => process.disconnect()); }
    catch (error) { process.send({ kind: 'clientError', error: error.stack }, () => process.disconnect()); }
  });
}
module.exports = { load, scheduleAbsolute };
