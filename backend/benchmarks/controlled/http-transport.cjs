'use strict';
const http = require('http');
const { performance } = require('perf_hooks');

// Retire FREE sockets before the benchmark server's advertised 5 s expiry.
// Do not apply this deadline to an active prediction/execution response.
class BenchmarkAgent extends http.Agent {
  constructor(maxOutstanding, idleTimeoutMs = 4000) {
    super({ keepAlive: true, maxSockets: maxOutstanding, maxFreeSockets: 256 });
    this.idleTimeoutMs = idleTimeoutMs;
  }
  keepSocketAlive(socket) {
    if (!super.keepSocketAlive(socket)) return false;
    let timeout = this.idleTimeoutMs;
    const hint = socket._httpMessage?.res?.headers['keep-alive'];
    const seconds = /^timeout=(\d+)/.exec(hint || '')?.[1];
    if (seconds != null) {
      const safeMs = Number(seconds) * 1000 - 1000;
      if (safeMs <= 0) return false;
      timeout = Math.min(timeout, safeMs);
    }
    socket.setTimeout(timeout);
    return true;
  }
  reuseSocket(socket, req) {
    socket.setTimeout(0);
    super.reuseSocket(socket, req);
  }
}

function transportObserver(now = () => performance.now()) {
  const sockets = [], events = [];
  const identities = new WeakMap();
  function event(socket, kind, extra = {}) {
    events.push({ socketId: identities.get(socket)?.socketId, kind, atMs: now(), epochMs: Date.now(), ...extra });
  }
  function track(socket) {
    let row = identities.get(socket);
    if (row) return row;
    row = { socketId: sockets.length + 1, observedMs: now(), assignments: [] };
    sockets.push(row); identities.set(socket, row);
    const endpoint = () => Object.assign(row, { localAddress: socket.localAddress, localPort: socket.localPort,
      remoteAddress: socket.remoteAddress, remotePort: socket.remotePort });
    endpoint();
    socket.once('connect', () => { endpoint(); event(socket, 'connect'); });
    for (const kind of ['end', 'timeout']) socket.on(kind, () => event(socket, kind));
    socket.on('error', error => event(socket, 'error', { code: error.code, message: error.message }));
    socket.once('close', hadError => event(socket, 'close', { hadError }));
    event(socket, 'observed', { connecting: socket.connecting, timeoutMs: socket.timeout || 0 });
    return row;
  }
  function assign(socket, requestId, extra = {}) {
    const row = track(socket);
    row.assignments.push({ requestId, atMs: now(), ...extra });
    return row.socketId;
  }
  return { sockets, events, track, assign, event };
}

function agentConfig(agent) {
  return { keepAlive: agent.keepAlive, keepAliveMsecs: agent.keepAliveMsecs,
    scheduling: agent.scheduling, maxSockets: agent.maxSockets, maxFreeSockets: agent.maxFreeSockets,
    activeSocketTimeoutMs: agent.options.timeout || 0, freeSocketTimeoutMs: agent.idleTimeoutMs ?? 0,
    agentKeepAliveTimeoutBufferMs: agent.agentKeepAliveTimeoutBuffer ?? null };
}
function serverConfig(server) {
  return { keepAliveTimeoutMs: server.keepAliveTimeout,
    keepAliveTimeoutBufferMs: server.keepAliveTimeoutBuffer ?? null,
    headersTimeoutMs: server.headersTimeout, requestTimeoutMs: server.requestTimeout,
    socketTimeoutMs: server.timeout, maxRequestsPerSocket: server.maxRequestsPerSocket };
}
module.exports = { BenchmarkAgent, transportObserver, agentConfig, serverConfig };
