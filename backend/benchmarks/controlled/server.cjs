'use strict';
const http = require('http');
const { performance } = require('perf_hooks');
const { transportObserver, serverConfig } = require('./http-transport.cjs');
const config = require('../../src/config');
const { configure, create } = require('./variants.cjs');
const { observer } = require('./observe.cjs');
const arm = process.argv[2];
const overrides = configure(arm, config);
const observations = observer(); observations.installExecutor();
// Must import gateways after installing the execution observer.
const MetricsStore = require('../../src/metrics/metricsStore');
const metrics = new MetricsStore(arm);
const gateway = create(arm, metrics, config);
observations.attach(gateway);
const samples = []; const active = new Set(); let runId, traceHash, cpuStart, startMs, timer;
const transport = transportObserver();
function sample() {
  samples.push({ epochMs: Date.now(), atMs: performance.now(), cpu: process.cpuUsage(), rssBytes: process.memoryUsage().rss,
    execution: gateway.rate?.run ? { active: gateway.rate.active, queued: gateway.rate.queue.length } : gateway.concurrency?.stats(),
    prediction: gateway.predictionQueue?.stats(), budgetWaiting: gateway.budgetWaitQueue?.queue.length });
}
const server = http.createServer((req, res) => {
  if (req.url !== '/execute' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  const acceptedAtMs = performance.now(); let body = '';
  const socketId = transport.track(req.socket).socketId;
  req.on('aborted', () => transport.event(req.socket, 'request_aborted', { socketId }));
  req.on('error', error => transport.event(req.socket, 'request_error', { code:error.code, message:error.message }));
  req.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    let request;
    try { request = JSON.parse(body); if (!request.requestId || !request.type || !runId) throw new Error('invalid request'); }
    catch { res.writeHead(400); res.end(); return; }
    transport.assign(req.socket, request.requestId);
    // Ordinary HTTP parsing surrounds the unmodified handle method. Response data
    // has the existing embedded gateway status, rather than inventing HTTP success.
    const task = observations.handle(gateway, request, { runId, arm, acceptedAtMs });
    active.add(task);
    task.then(outcome => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(outcome)); }, error => {
      const row = observations.rows.find(r => r.requestId === request.requestId);
      row.outcome = { status: 500, decision: 'REJECT', reason: 'benchmark_handler_error', error: error.message };
      res.writeHead(500); res.end(JSON.stringify(row.outcome));
    }).finally(() => active.delete(task));
  });
});
server.on('connection', socket => transport.track(socket));
server.on('close', () => transport.events.push({ kind:'server_close', atMs:performance.now(), epochMs:Date.now() }));
server.on('error', error => transport.events.push({ kind:'server_error', atMs:performance.now(), epochMs:Date.now(), code:error.code, message:error.message }));
// Observe existing Node clientError handling without replacing its default close
// behavior: adding a clientError listener would change HTTP parser error handling.
const originalEmit = server.emit;
server.emit = function(kind, ...args) {
  if (kind === 'clientError') transport.event(args[1], 'client_error', { code:args[0].code, message:args[0].message });
  return originalEmit.call(this, kind, ...args);
};
process.on('message', message => {
  if (message.kind === 'begin') {
    runId = message.runId; traceHash = message.traceHash;
    metrics.markExperimentStart(message.durationSec, runId);
    cpuStart = process.cpuUsage(); startMs = performance.now(); sample(); timer = setInterval(sample, 1000);
    process.send({ kind: 'begun' });
  } else if (message.kind === 'snapshot') {
    clearInterval(timer); sample(); metrics.markExperimentEnd();
    const delta = process.cpuUsage(cpuStart);
    process.send({ kind: 'snapshot', data: { runId, traceHash, arm, config, overrides,
      rows: observations.rows, snapshot: metrics.snapshot(), queuePeaks: observations.queuePeaks,
      transport: { server:serverConfig(server), sockets:transport.sockets, events:transport.events,
        clock:'server process monotonic milliseconds; epochMs for coarse cross-process correlation' },
      resources: { node: { cpuSeconds: (delta.user + delta.system) / 1e6, elapsedSec: (performance.now() - startMs) / 1000,
        peakRssBytes: Math.max(...samples.map(s => s.rssBytes)), sampledMeanRssBytes: samples.reduce((sum,s) => sum+s.rssBytes,0)/samples.length, samples },
        perRequestCpuWarning: 'executor cpuMs includes overlapping work and must not be summed' },
      pending: active.size, initialState: { freshProcess: true, budgetAndTokensFresh: true, cachesCold: true, estimatorSamplesInitiallyZero: true } } });
  } else if (message.kind === 'stop') {
    clearInterval(timer); clearInterval(metrics._timer); server.close(); process.exit(0);
  }
});
server.listen(0, '127.0.0.1', () => process.send({ kind: 'ready', port: server.address().port, pid: process.pid, config, overrides, httpTransport:serverConfig(server) }));
