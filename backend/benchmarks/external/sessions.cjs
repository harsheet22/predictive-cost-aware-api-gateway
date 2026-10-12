'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { randomUUID } = require('crypto');
const { root, sha, write, summarize } = require('../controlled/common.cjs');
const { validateTrace, validateClient, LIMITS } = require('./trace.cjs');
const { startWorker } = require('./worker.cjs');
function integrity() {
  const files = {};
  for (const dir of ['backend/src', 'backend/benchmarks/external', 'backend/benchmarks/controlled', 'ml-service/app', 'ml-service/models']) {
    const visit = relative => { for (const e of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (e.name === '__pycache__') continue;
      const file = path.join(relative, e.name);
      if (e.isDirectory()) visit(file); else files[file.replaceAll('\\', '/')] = sha(fs.readFileSync(path.join(root, file)));
    } }; visit(dir);
  }
  return files;
}
function makeComparison(session) {
  const b = session.arms.baseline.server.snapshot, p = session.arms.predictive.server.snapshot;
  const baselineCost = b.cost.estimatedCloudCostUsd, delta = baselineCost - p.cost.estimatedCloudCostUsd;
  return { runId: session.id, telemetryVersion: 1, source: 'external', profile: session.input.profile, seed: session.input.seed,
    durationSec: session.input.durationSec, totalRequests: session.input.requests.length, slaTargetMs: session.arms.predictive.server.config.sla.targetLatencyMs,
    baseline: b, predictive: p, failures: { baseline: [], predictive: [] },
    validation: { sameRun: b.experiment.runId === session.id && p.experiment.runId === session.id,
      reconciled: [b,p].every(s => s.inFlight === 0 && s.incoming === s.processed + s.rejected), externalValid: Object.values(session.arms).every(a => a.summary.valid) },
    savings: { absoluteUsd: delta, percent: baselineCost ? 100 * delta / baselineCost : null },
    external: { traceHash: session.input.hash, configuredRate: session.input.rate,
      baseline: session.arms.baseline.summary, predictive: session.arms.predictive.summary,
      limitations: session.limitations },
  };
}
class ExternalSessions {
  constructor({ workerFactory = startWorker, outputRoot = path.join(root, 'backend/experiments'), idleMs = 60000, hashSource = integrity, mlHealth } = {}) {
    this.workerFactory = workerFactory; this.outputRoot = outputRoot; this.idleMs = idleMs; this.hashSource = hashSource;
    this.mlHealth = mlHealth || (async () => { const r = await fetch(`${process.env.ML_SERVICE_URL || 'http://localhost:8000'}/health`, { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error('ML health unavailable'); return r.json(); });
    this.current = null; this.recent = [];
  }
  busy() { return this.current && (this.current.cleanupBlocked || !['complete','invalid','failed'].includes(this.current.state)); }
  guard(id) { if (!this.current || this.current.id !== id) throw Object.assign(new Error('Unknown external run'), { status: 404 }); return this.current; }
  status() {
    const s = this.current; if (!s) return { state: 'idle' };
    return { id: s.id, state: s.state, arm: s.arm, profile: s.input.profile, seed: s.input.seed, rate: s.input.rate, durationSec: s.input.durationSec,
      totalRequests: s.input.requests.length, received: s.seen?.size || 0, completedResponses: s.responses || 0, pending: s.pending?.size || 0,
      error: s.error, cleanupBlocked: Boolean(s.cleanupBlocked), createdAt: s.createdAt, comparison: s.comparison,
      summaries: Object.fromEntries(Object.entries(s.arms).map(([arm,a]) => [arm,a.summary])), limitations: s.limitations };
  }
  save(s, name, data) { write(path.join(s.directory, name), data); }
  remember(s) {
    if (this.recent.some(r => r.id === s.id)) return;
    this.recent.unshift({ id:s.id, state:s.state, rate:s.input.rate, profile:s.input.profile, createdAt:s.createdAt, directory:s.directory });
    this.recent = this.recent.slice(0,10);
  }
  history() { return this.recent.map(({ directory, ...item })=>item); }
  report(id) {
    if(this.current?.id === id) { const s=this.current; return { ...this.status(), trace:s.input, sourceHashes:s.sourceHashes,
      modelHealth:s.modelHealth, arms:s.arms, serverEvidenceDirectory:s.directory }; }
    const saved=this.recent.find(r=>r.id===id);if(!saved)throw Object.assign(new Error('Unknown external run'),{status:404});
    return JSON.parse(fs.readFileSync(path.join(saved.directory,'report.json'),'utf8'));
  }
  armTimeout(s, milliseconds) {
    clearTimeout(s.timer); s.timer = setTimeout(() => { this.fail(s, 'External run observation deadline reached').catch(() => {}); }, milliseconds); s.timer.unref?.();
  }
  async create(input, drainSec = 300) {
    validateTrace(input);
    if (!Number.isFinite(drainSec) || drainSec < 0 || drainSec > LIMITS.maxDrainSec) throw new Error('Invalid drain period');
    if (this.busy()) throw Object.assign(new Error('An external comparison is already active'), { status: 409 });
    const s = { id: randomUUID(), createdAt: new Date().toISOString(), state: 'created', arms: {}, input: structuredClone(input), drainSec,
      sourceHashes: this.hashSource(), limitations: ['Current-system comparison: execution quality, response caching and CPU-prefix reuse differ.',
        'Gateway workers are fresh isolated Node processes; the existing ML service is shared and its warm state is not reset.',
        'Gateway CPU/RSS observations exclude the parent proxy and shared Python service; whole-instance resources require CloudWatch.',
        'Client latency includes network and the API proxy; gateway latency starts inside the isolated worker.',
        'Execution costs are synthetic estimates, not AWS charges.'] };
    s.directory = path.join(this.outputRoot, `external-demo-${s.createdAt.replaceAll(':','-')}-${s.id.slice(0,8)}`);
    this.save(s, 'trace.json', s.input); this.save(s, 'manifest.json', { runId:s.id, createdAt:s.createdAt, drainSec, traceHash:input.hash, sourceHashes:s.sourceHashes,
      environment:{ platform:os.platform(), architecture:os.arch(), node:process.version, parentPid:process.pid }, limits:LIMITS, limitations:s.limitations });
    this.current = s; this.armTimeout(s, this.idleMs); return this.status();
  }
  async begin(id, arm) {
    const s = this.guard(id);
    if ((s.state !== 'created' || arm !== 'baseline') && (s.state !== 'baseline-complete' || arm !== 'predictive')) throw Object.assign(new Error('Arms must run once in baseline then predictive order'), { status:409 });
    s.state = 'starting'; s.arm = arm; this.armTimeout(s, this.idleMs);
    try {
      if (arm === 'predictive') { s.modelHealth = await this.mlHealth(); if (!s.modelHealth.modelLoaded) throw new Error('RandomForest model is unavailable'); }
      const worker = await this.workerFactory(arm, s.input, s.id);
      if (s.state !== 'starting') { await worker.stop(); throw new Error('Run expired during startup'); }
      s.worker = worker; s.seen = new Set(); s.pending = new Set(); s.responses = 0;
      s.byId = new Map(s.input.requests.map(r => [r.requestId, JSON.stringify(r)]));
      this.save(s, `${arm}-process.json`, worker.ready);
      s.state = 'running'; this.armTimeout(s, (s.input.durationSec + s.drainSec + 45) * 1000); return this.status();
    } catch (error) { await this.fail(s,error.message); throw error; }
  }
  async execute(id, arm, request) {
    const s = this.guard(id);
    if (s.state !== 'running' || s.arm !== arm) throw Object.assign(new Error('This arm is not accepting requests'), { status:409 });
    if (!request || s.byId.get(request.requestId) !== JSON.stringify(request)) throw new Error('Request differs from the saved trace');
    if (s.seen.has(request.requestId)) throw Object.assign(new Error('Duplicate request; retries are not allowed'), { status:409 });
    s.seen.add(request.requestId);
    const task = s.worker.execute(request); s.pending.add(task);
    try { const result = await task; s.responses++; return result; } finally { s.pending.delete(task); }
  }
  async finish(id, arm, client) {
    const s = this.guard(id);
    if (s.state !== 'running' || s.arm !== arm) throw Object.assign(new Error('Arm is not running'), { status:409 });
    validateClient(s.input,client); s.state = 'finalizing'; let finalState;
    this.armTimeout(s, (s.drainSec + 45) * 1000);
    try {
      this.save(s, `${arm}-client.json`, client);
      // Keep observing work accepted by the gateway, even if the client has timed out.
      const deadline = Date.now() + s.drainSec * 1000;
      while (s.state === 'finalizing' && s.pending.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,20));
      if (s.state !== 'finalizing') throw new Error('Run stopped during final observation');
      const server = await s.worker.snapshot(); this.save(s, `${arm}-server.json`, server);
      if (s.state !== 'finalizing') throw new Error('Run stopped during snapshot');
      const summary = summarize(s.input,client,server);
      summary.checks.noTransportErrors = summary.counts.transportErrors === 0;
      summary.checks.noUnresolvedAtCutoff = client.unresolvedAtCutoff === 0 && server.pending === 0;
      summary.checks.noSilentFallback = !server.snapshot.ml.fallbackCount;
      summary.checks.modelLoaded = arm !== 'predictive' || s.modelHealth?.modelLoaded === true;
      summary.checks.sourceModelUnchanged = JSON.stringify(s.sourceHashes) === JSON.stringify(this.hashSource());
      summary.valid = Object.values(summary.checks).every(Boolean);
      s.arms[arm] = { server, client, summary }; this.save(s, `${arm}-summary.json`, summary);
      if (!summary.valid) { finalState='invalid'; s.error=`${arm} failed: ${Object.entries(summary.checks).filter(([,ok])=>!ok).map(([name])=>name).join(', ')}`; }
      else finalState = arm === 'baseline' ? 'baseline-complete' : 'complete';
      if (finalState === 'complete') { s.comparison=makeComparison(s); this.save(s,'comparison.json',s.comparison); }
    } catch(error) { finalState='failed'; s.error=error.message; throw error; }
    finally {
      clearTimeout(s.timer);
      try { await s.worker.stop(); } catch(error) { s.cleanupBlocked=true; finalState='failed'; s.error=`Worker cleanup failed: ${error.message}`; }
      s.state = finalState || 'failed';
      try { this.save(s,`${arm}-process.log`,s.worker.logs.join('')); this.save(s,`${arm}-state.json`,this.status()); } catch(error) { s.state='failed'; s.error=`Evidence write failed: ${error.message}`; }
      s.worker = null;
      if(s.state === 'baseline-complete') this.armTimeout(s,this.idleMs);
      else { this.remember(s); try { this.save(s,'report.json',this.report(s.id)); } catch(error) { s.state='failed'; s.error=`Report write failed: ${error.message}`; } }
    }
    return this.status();
  }
  async fail(s,reason) {
    clearTimeout(s.timer); s.state='stopping'; s.error=reason;
    try { if(s.worker) { const partial=await s.worker.snapshot(); this.save(s,`${s.arm}-partial-server.json`,partial); } }
    catch(error) { s.error += `; partial snapshot unavailable: ${error.message}`; }
    finally { if(s.worker) { try { await s.worker.stop(); } catch(error) { s.cleanupBlocked=true; s.error += `; cleanup failed: ${error.message}`; } } s.state='failed'; this.remember(s); try { this.save(s,`failure-${randomUUID()}.json`,this.status()); this.save(s,'report.json',this.report(s.id)); } catch(error) { s.error += `; evidence write failed: ${error.message}`; } }
  }
}
module.exports = { ExternalSessions, makeComparison, integrity };
