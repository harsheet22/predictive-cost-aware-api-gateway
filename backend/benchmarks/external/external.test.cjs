'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const os=require('os');const path=require('path');const http=require('http');
const {makeTrace,validateTrace,LIMITS}=require('./trace.cjs');const {parse}=require('./run.cjs');
const {load}=require('./load.cjs');const {ExternalSessions}=require('./sessions.cjs');
const MetricsStore=require('../../src/metrics/metricsStore');const config=require('../../src/config');
function harness(options={}){
  const outputRoot=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-external-test-'));const workers=[];
  const workerFactory=async(arm,input,id)=>{
    const metrics=new MetricsStore(arm);clearInterval(metrics._timer);metrics.markExperimentStart(input.durationSec,id);
    const rows=[];const w={ready:{pid:100+workers.length,config,overrides:[]},logs:[],stopped:0,
      execute:async request=>{const outcome={status:200,decision:'ALLOW',reason:'cheap_and_budget_ok',latencyMs:10,actualCloudCostUsd:0.000001,precision:'full'};
        metrics.begin();metrics.record({...outcome,slaMet:true,actualCostUsd:outcome.actualCloudCostUsd,actualCostMs:10});rows.push({requestId:request.requestId,gatewayEntryMs:1,gatewayEndMs:11,outcome});return{httpStatus:200,outcome};},
      snapshot:async()=>{metrics.markExperimentEnd();return{arm,runId:id,traceHash:input.hash,config,rows,snapshot:metrics.snapshot(),pending:0,resources:{node:{cpuSeconds:0,peakRssBytes:1}},queuePeaks:{}};},
      stop:async()=>{w.stopped++;if(options.stop)await options.stop();}};
    workers.push(w);return w;
  };
  const manager=new ExternalSessions({workerFactory,outputRoot,idleMs:100000,hashSource:()=>({source:'unchanged'}),mlHealth:async()=>({modelLoaded:true}),...options});
  return{manager,workers,outputRoot};
}
function tiny(){return makeTrace({profile:'mixed',rate:25,seed:42,durationSec:.3});}
async function dispatchAll(manager,id,arm,input){const rows=[];for(const r of input.requests){const {outcome}=await manager.execute(id,arm,r);rows.push({requestId:r.requestId,scheduledMs:r.arrivalOffsetMs,dispatchMs:r.arrivalOffsetMs,attempts:1,responseMs:r.arrivalOffsetMs+10,outcome});}
  return{traceHash:input.hash,rows,elapsedMs:input.durationSec*1000+20,unresolvedAtCutoff:0};}
test('external CLI and trace reject invalid targets, ranges, hashes, duplicate IDs and altered arrivals',()=>{
  assert.deepEqual(parse(['--url','http://localhost:3000']).rates,[10,25,50]);
  for(const argv of [['--url','ftp://localhost'],['--url','http://u:p@localhost'],['--url','http://localhost/path'],['--url','http://localhost','--rates','101'],['--url','http://localhost','--rates','10,10'],['--url','http://localhost','--duration','31'],['--url','http://localhost','--max-outstanding','513']])assert.throws(()=>parse(argv));
  const input=tiny();assert.equal(validateTrace(input),input);
  const a=structuredClone(input);a.requests[0].payloadSize++;assert.throws(()=>validateTrace(a),/hash/);
  const b=structuredClone(input);b.requests[1].requestId=b.requests[0].requestId;assert.throws(()=>validateTrace(b),/request/);
  const c=structuredClone(input);c.requests[0].arrivalOffsetMs=-1;assert.throws(()=>validateTrace(c),/arrival/);
  assert.ok(LIMITS.maxRequests>=input.requests.length);
});
test('same trace runs exactly once per fresh arm; responses and saved evidence reconcile',async()=>{
  const {manager,workers,outputRoot}=harness();const input=tiny();const s=await manager.create(input,0);
  try{
    await assert.rejects(manager.create(input),/already active/);
    await assert.rejects(manager.begin(s.id,'predictive'),/order/);
    await manager.begin(s.id,'baseline');const client=await dispatchAll(manager,s.id,'baseline',input);
    await assert.rejects(manager.execute(s.id,'baseline',input.requests[0]),/Duplicate/);
    const done=await manager.finish(s.id,'baseline',client);assert.equal(done.state,'baseline-complete');assert.equal(done.summaries.baseline.valid,true);
    await manager.begin(s.id,'predictive');const predictive=await dispatchAll(manager,s.id,'predictive',input);const result=await manager.finish(s.id,'predictive',predictive);
    assert.equal(result.state,'complete');assert.equal(workers.length,2);assert.equal(workers[0].stopped,1);assert.equal(workers[1].stopped,1);
    assert.equal(result.comparison.baseline.experiment.runId,result.comparison.predictive.experiment.runId);
    assert.equal(result.comparison.external.traceHash,input.hash);assert.equal(manager.history().length,1);assert.equal(manager.busy(),false);
    const dir=manager.report(s.id).serverEvidenceDirectory;assert.ok(fs.existsSync(path.join(dir,'baseline-server.json')));assert.ok(fs.existsSync(path.join(dir,'predictive-client.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'trace.json'))).hash,input.hash);
  }finally{clearTimeout(manager.current.timer);}
  assert.ok(fs.existsSync(outputRoot));
});
test('altered request never reaches worker and an invalid timing arm blocks predictive',async()=>{
  const {manager,workers}=harness();const input=tiny();const s=await manager.create(input,0);await manager.begin(s.id,'baseline');
  const altered={...input.requests[0],priority:'high'};if(altered.priority===input.requests[0].priority)altered.priority='low';
  await assert.rejects(manager.execute(s.id,'baseline',altered),/differs/);assert.equal(manager.status().received,0);
  const client=await dispatchAll(manager,s.id,'baseline',input);client.rows.forEach(r=>{r.dispatchMs+=50;r.responseMs+=50;});
  const result=await manager.finish(s.id,'baseline',client);assert.equal(result.state,'invalid');assert.equal(result.summaries.baseline.checks.timing,false);
  await assert.rejects(manager.begin(s.id,'predictive'),/order/);assert.equal(workers.length,1);assert.equal(workers[0].stopped,1);
});
test('write failure still stops worker; new run cannot start during cleanup',async()=>{
  let release;const cleanup=new Promise(resolve=>{release=resolve;});const {manager,workers}=harness({stop:()=>cleanup});const input=tiny();const s=await manager.create(input,0);await manager.begin(s.id,'baseline');const client=await dispatchAll(manager,s.id,'baseline',input);
  const saved=manager.save.bind(manager);manager.save=(session,name,data)=>{if(name==='baseline-client.json')throw new Error('disk full');return saved(session,name,data);};
  const failed=manager.finish(s.id,'baseline',client);const caught=assert.rejects(failed,/disk full/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(manager.status().state,'finalizing');await assert.rejects(manager.create(input),/already active/);
  release();await caught;assert.equal(workers[0].stopped,1);assert.equal(manager.status().state,'failed');
});
test('source integrity change invalidates results instead of fabricating success',async()=>{
  let changed=false;const {manager}=harness({hashSource:()=>({source:changed?'changed':'old'})});const input=tiny();const s=await manager.create(input,0);await manager.begin(s.id,'baseline');const client=await dispatchAll(manager,s.id,'baseline',input);changed=true;
  const result=await manager.finish(s.id,'baseline',client);assert.equal(result.summaries.baseline.checks.sourceModelUnchanged,false);assert.equal(result.state,'invalid');
});
test('unavailable model fails before predictive worker starts',async()=>{
  const {manager,workers}=harness({mlHealth:async()=>({modelLoaded:false})});const input=tiny();const s=await manager.create(input,0);await manager.begin(s.id,'baseline');await manager.finish(s.id,'baseline',await dispatchAll(manager,s.id,'baseline',input));
  await assert.rejects(manager.begin(s.id,'predictive'),/unavailable/);assert.equal(workers.length,1);assert.equal(manager.status().state,'failed');
});
test('ML fallback invalidates the predictive arm and preserves observations',async()=>{
  const {manager,workers}=harness();const input=tiny();const s=await manager.create(input,0);await manager.begin(s.id,'baseline');await manager.finish(s.id,'baseline',await dispatchAll(manager,s.id,'baseline',input));
  await manager.begin(s.id,'predictive');const original=workers[1].snapshot;workers[1].snapshot=async()=>{const data=await original();data.snapshot.ml.fallbackCount=1;return data;};
  const result=await manager.finish(s.id,'predictive',await dispatchAll(manager,s.id,'predictive',input));assert.equal(result.state,'invalid');assert.equal(result.summaries.predictive.checks.noSilentFallback,false);assert.ok(manager.report(s.id).arms.predictive.server.rows.length);
});
test('startup interruption stops the late worker and cleanup failure blocks new sessions',async()=>{
  let release;let stops=0;const started=new Promise(resolve=>{release=resolve;});
  const {manager}=harness({workerFactory:()=>started});const input=tiny();const s=await manager.create(input,0);
  const launch=manager.begin(s.id,'baseline');const rejected=assert.rejects(launch,/expired during startup/);
  await manager.fail(manager.current,'startup cancelled');release({stop:async()=>{stops++;},ready:{},logs:[]});await rejected;assert.equal(stops,1);assert.equal(manager.status().state,'failed');
  const blocked=harness({stop:async()=>{throw new Error('exit unverified');}});const next=await blocked.manager.create(input,0);await blocked.manager.begin(next.id,'baseline');
  const result=await blocked.manager.finish(next.id,'baseline',await dispatchAll(blocked.manager,next.id,'baseline',input));assert.equal(result.cleanupBlocked,true);assert.equal(result.state,'failed');await assert.rejects(blocked.manager.create(input),/already active/);
});
test('real baseline worker uses a separate process and verifies its exit',async()=>{
  const {startWorker}=require('./worker.cjs');const input=tiny();const worker=await startWorker('baseline',input,'local-worker-test');
  try{assert.notEqual(worker.ready.pid,process.pid);assert.deepEqual(worker.ready.overrides,[]);const response=await worker.execute(input.requests[0]);assert.equal(response.outcome.status,200);const report=await worker.snapshot();assert.equal(report.initialState.freshProcess,true);assert.equal(report.rows.length,1);}
  finally{await worker.stop();}
  assert.equal(worker.alive(),false);
});
test('HTTP 200 with embedded rejection is retained; transport failure is not retried',async()=>{
  let calls=0;const server=http.createServer((req,res)=>{calls++;req.resume();req.on('end',()=>{if(calls===2){req.socket.destroy();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({status:503,decision:'REJECT',reason:'prediction_queue_full'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const input=tiny();input.requests=input.requests.slice(0,2);input.requests.forEach((r,i)=>{r.arrivalOffsetMs=2+i*5;});input.durationSec=.03;
    const result=await load({input,url:`http://127.0.0.1:${server.address().port}/execute`,drainSec:1});
    assert.equal(calls,2);assert.equal(result.rows[0].outcome.status,503);assert.equal(result.rows[0].transportError,undefined);assert.ok(result.rows[1].transportError);assert.equal(result.rows[1].attempts,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
