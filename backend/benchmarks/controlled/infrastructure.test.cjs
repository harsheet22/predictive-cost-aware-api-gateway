'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fork, execFileSync } = require('child_process');
const path = require('path');
const { trace, stats, summarize, write } = require('./common.cjs');
const { parse, requireValidRun } = require('./run.cjs');
const { load, scheduleAbsolute } = require('./loadgen.cjs');
const { BenchmarkAgent, transportObserver, agentConfig, serverConfig } = require('./http-transport.cjs');
const { observer } = require('./observe.cjs');
const { configure, create } = require('./variants.cjs');
test('trace has identical complete inputs and offsets for the same seed', () => {
  assert.deepEqual(trace('stress', 42, 1), trace('stress', 42, 1));
  assert.notEqual(trace('stress', 42, 1).hash, trace('stress', 43, 1).hash);
  assert.throws(() => trace('invented', 42, 1));
});
test('CLI never defaults to the full matrix and bounds screening', () => {
  assert.equal(parse([]).mode, 'screen');
  assert.throws(() => parse(['--mode','screen','--duration','60']));
  assert.throws(() => parse(['--max-outstanding','0']));
  assert.throws(() => parse(['--seeds','42,42']));
});
test('nearest rank and missing samples are explicit', () => {
  assert.deepEqual(stats([1,2,3,4]), { n:4, mean:2.5, p50:2, p95:4, p99:4, max:4 });
  assert.equal(stats([null,undefined]).mean, null);
});

test('first invalid arm is retained and stops subsequent arms without relaxing checks', () => {
  const valid = { result: { valid: true, checks: { dispatchTimingAcceptable: true } } };
  const invalid = { experiment: 'A', profile: 'stress', seed: 42, arm: 'predictive',
    result: { valid: false, checks: { dispatchTimingAcceptable: false, countsReconcile: true } } };
  const retained = [];
  assert.throws(() => {
    for (const row of [valid, invalid, valid]) {
      retained.push(row);
      requireValidRun(row);
    }
  }, error => error.code === 'BENCHMARK_VALIDITY_FAILED'
    && error.message.includes('A/stress/42/predictive')
    && error.message.includes('dispatchTimingAcceptable'));
  assert.deepEqual(retained, [valid, invalid]);
  assert.equal(invalid.result.checks.dispatchTimingAcceptable, false);
});
test('writing existing artifacts is refused', () => {
  assert.throws(() => write(__filename, 'overwrite'), error => error.code === 'EEXIST');
});
test('overrides affect only a supplied benchmark configuration and disable every downgrade', () => {
  const actual = require('../../src/config'), before = JSON.stringify(actual);
  const copy = structuredClone(actual); configure('policy', copy);
  assert.equal(copy.predictive.downgrade.enabled, false);
  assert.deepEqual(copy.predictive.optimization.reducedQualityTypes, []);
  assert.equal(copy.predictive.optimization.hashPrefixReuse, false);
  assert.equal(JSON.stringify(actual), before);
  const unchanged = structuredClone(actual); assert.deepEqual(configure('baseline', unchanged), []); assert.deepEqual(unchanged, actual);
});
test('observer calls decisions and HTTP once and preserves returned values/errors', async () => {
  const observations = observer(); let decisions = 0, calls = 0;
  const expected = { decision:'ALLOW', reason:'original', status:200 };
  const gateway = { engine:{ decidePrediction(){ decisions++; return expected; } },
    predictionQueue:{ onEvent() {} }, mlClient:{ async predict(){ calls++; return { predictedCostMs:10 }; } },
    budgetWaitQueue:{ queue:[], run(){ return Promise.resolve({ decision:expected }); } } };
  gateway.handle = async request => {
    await gateway.mlClient.predict(request);
    return gateway.engine.decidePrediction(request, {}, {});
  };
  observations.attach(gateway);
  const actual = await observations.handle(gateway, { requestId:'same' }, {});
  assert.strictEqual(actual, expected); assert.equal(decisions,1); assert.equal(calls,1);
  assert.equal(observations.rows[0].policyEvaluations.length,1);
  observations.restore();
});
test('prediction events follow their explicit IDs even under another request context', async () => {
  const observations = observer();
  const gateway = { predictionQueue:{ onEvent(){} }, mlClient:{ async predict(){ return {}; } },
    budgetWaitQueue:{ queue:[], run(){ return Promise.resolve({}); } }, async handle(){ return { status:200 }; } };
  observations.attach(gateway);
  await observations.handle(gateway, {requestId:'a'}, {});
  await observations.handle(gateway, {requestId:'b'}, {});
  gateway.predictionQueue.onEvent({kind:'start',requestId:'a',actualWaitMs:7});
  gateway.predictionQueue.onEvent({kind:'rejection',requestId:'b',reason:'prediction_queue_full'});
  assert.equal(observations.rows[0].predictionStart.actualWaitMs,7);
  assert.equal(observations.rows[1].predictionRejection.reason,'prediction_queue_full');
});
test('observed actual DecisionEngine matches unobserved decisions at identical fixed states', async () => {
  const { DecisionEngine } = require('../../src/decision/decisionEngine');
  const budget = { remainingUsd: () => .001 };
  const original = new DecisionEngine({}, budget), observed = new DecisionEngine({}, budget);
  const observations = observer();
  const gateway = { engine:observed, async handle(request) {
    return observed.decidePrediction(request, request.state, request.prediction);
  } };
  observations.attach(gateway);
  for (const [index, scenario] of [
    ['db_query','normal',.000001,0,0], ['image_resize','low',.000001,0,0],
    ['hash_compute','normal',.002,100,8], ['report_generate','high',.0004,0,0],
    ['db_query','low',.0004,80,8], ['image_resize','normal',.0004,0,0],
  ].entries()) {
    const [type,priority,cost,cpuPct,concurrent] = scenario;
    const request = { requestId:String(index), type, priority, precision:'full', payloadSize:1000,
      state:{cpuPct,concurrent,queueDepth:0}, prediction:{predictedCostMs:30,predictedCloudCostUsd:cost} };
    const expected = original.decidePrediction(request,request.state,request.prediction);
    assert.deepEqual(await observations.handle(gateway,request,{}),expected);
  }
  assert.equal(observations.rows.length,6);
  assert.ok(observations.rows.every(row => row.policyEvaluations.length === 1));
  observations.restore();
});
test('ML resource sampler reads the actual Python interpreter PID and CPU/RSS', () => {
  const python = process.env.BENCH_PYTHON || path.resolve(__dirname,'../../../ml-service/.venv',process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const sampler = path.join(__dirname,'resource_sampler.py');
  const script = 'import os,importlib.util,json,sys; spec=importlib.util.spec_from_file_location("sampler",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); before=m.sample(os.getpid()); sum(i*i for i in range(1000000)); after=m.sample(os.getpid()); print(json.dumps({"pid":os.getpid(),"before":before,"after":after}))';
  const result = JSON.parse(execFileSync(python,['-B','-c',script,sampler],{encoding:'utf8',windowsHide:true}));
  assert.ok(result.pid > 0); assert.ok(result.after.rssBytes > 1024);
  assert.ok(result.after.cpuSeconds > result.before.cpuSeconds);
});
test('absolute scheduler catches arrivals becoming due during submission in the same batch', async () => {
  let clock = 0; const timers = [], sent = [], wakeups = [];
  const requests = [5,10,10].map((arrivalOffsetMs, requestId) => ({arrivalOffsetMs,requestId}));
  const finished = scheduleAbsolute({requests,start:0,now:()=>clock,wakeups,
    setTimer:(callback,wait)=>timers.push({callback,wait}), defer:()=>assert.fail('unexpected deferred catch-up'),
    dispatch:request=>{sent.push({id:request.requestId,at:clock}); if(request.requestId===0)clock+=17;} });
  assert.equal(timers.length,1); assert.equal(timers[0].wait,5);
  clock=5; timers.shift().callback(); await finished;
  assert.deepEqual(sent,[{id:0,at:5},{id:1,at:22},{id:2,at:22}]);
  assert.equal(timers.length,0); assert.equal(wakeups.length,1);
  assert.deepEqual(requests.map(r=>r.arrivalOffsetMs),[5,10,10]);
});
test('absolute scheduler does not move deadlines or hide an externally delayed wakeup', async () => {
  let clock=0; const timers=[], sent=[], wakeups=[];
  const done=scheduleAbsolute({requests:[{arrivalOffsetMs:5}],start:0,now:()=>clock,wakeups,
    setTimer:(callback,wait)=>timers.push({callback,wait}),dispatch:request=>sent.push(clock-request.arrivalOffsetMs)});
  clock=55; timers.shift().callback(); await done;
  assert.deepEqual(sent,[50]); assert.equal(wakeups[0].expectedOffsetMs,5); assert.equal(wakeups[0].enteredMs,55);
});
test('absolute scheduler waits for future arrivals and preserves input order', async () => {
  let clock=0;const timers=[],sent=[];
  const requests=[{requestId:'a',arrivalOffsetMs:5},{requestId:'b',arrivalOffsetMs:20}];
  const done=scheduleAbsolute({requests,start:0,now:()=>clock,
    setTimer:(callback,wait)=>timers.push({callback,wait}),dispatch:request=>sent.push(request.requestId)});
  clock=5;timers.shift().callback();assert.deepEqual(sent,['a']);assert.equal(timers[0].wait,15);
  clock=20;timers.shift().callback();await done;assert.deepEqual(sent,['a','b']);
});
test('pre-encoded submission preserves request bytes and provides timing observations', async () => {
  let received;
  const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{received=body;res.end(JSON.stringify({status:200}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const request={requestId:'unchanged',arrivalOffsetMs:0,payload:'λ',parameters:{iterations:42}};
    const result=await load({input:{durationSec:.02,hash:'h',requests:[request]},port:server.address().port,drainSec:1});
    assert.equal(received,JSON.stringify(request));assert.ok(result.rows[0].dispatchMs>=0);
    assert.ok(result.rows[0].submissionEndMs>=result.rows[0].dispatchMs);
    assert.equal(result.scheduler.wakeups[0].dispatched,1);assert.equal(result.rows[0].attempts,1);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('independent generator dispatches without waiting for responses; capacity losses are explicit', async () => {
  const server = http.createServer((req,res) => { req.resume(); setTimeout(() => res.end(JSON.stringify({status:200})),60); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const input = { durationSec:.1, hash:'test', requests:[0,5,10].map((offset,i) => ({requestId:String(i), arrivalOffsetMs:offset})) };
    const result = await load({input,port:server.address().port,drainSec:1,maxOutstanding:1});
    assert.equal(result.rows.length,3); assert.equal(result.rows.filter(r => r.capacityMiss).length,2);
    assert.equal(result.rows.filter(r => r.attempts === 1).length,1); assert.equal(result.rows[0].outcome.status,200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('drain cutoff records transport/unresolved state and does not retry', async () => {
  const server = http.createServer(req => req.resume());
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const result = await load({input:{durationSec:.02,hash:'x',requests:[{requestId:'x',arrivalOffsetMs:0}]},port:server.address().port,drainSec:.02});
    assert.equal(result.unresolvedAtCutoff,1); assert.equal(result.rows[0].attempts,1); assert.ok(result.rows[0].transportError);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('reconciliation preserves unentered requests and separates ML failure from rejection', () => {
  const input = {durationSec:1,hash:'h',requests:[{requestId:'a'},{requestId:'b'}]};
  const client = {traceHash:'h',elapsedMs:1000,rows:[{requestId:'a',scheduledMs:0,dispatchMs:1,attempts:1,transportError:'lost'},{requestId:'b',scheduledMs:5,dispatchMs:null,attempts:0,capacityMiss:true}]};
  const server = {traceHash:'h',config:{sla:{targetLatencyMs:250}},rows:[{requestId:'a',gatewayEntryMs:0,gatewayEndMs:20,outcome:{status:503,decision:'REJECT',reason:'ml_prediction_failed'}}],
    snapshot:{incoming:1,inFlight:0,processed:0,cost:{estimatedCloudCostUsd:0}},resources:{},queuePeaks:{}};
  const result = summarize(input,client,server);
  assert.equal(result.valid,false); assert.equal(result.counts.failed,1); assert.equal(result.counts.rejected,0);
  assert.equal(result.counts.notDispatched,1); assert.equal(result.cost.perSuccessfulCompletionUsd,null);
});
test('FIFO control uses existing capacity guard and performs full-quality execution', async () => {
  const Metrics = require('../../src/metrics/metricsStore'), config = require('../../src/config');
  const metrics = new Metrics('fifo-test');
  try {
    const gateway = create('fifo',metrics,config);
    assert.equal(gateway.rate.maxConcurrent,config.predictive.maxConcurrent);
    assert.equal(gateway.rate.maxQueue,config.predictive.maxQueue);
    const input = trace('light',42,1).requests[0];
    const outcome = await gateway.handle(input);
    assert.equal(outcome.status,200); assert.equal(outcome.precision,'full'); assert.equal(outcome.cached,false);
    assert.equal(metrics.snapshot().inFlight,0);
  } finally { clearInterval(metrics._timer); }
});
test('server processes have fresh state and benchmark overrides do not leak to as-is arm', async () => {
  async function launch(arm) {
    const child = fork(path.join(__dirname,'server.cjs'),[arm],{silent:true,windowsHide:true});
    try {
      return await new Promise((resolve,reject) => {
        const timeout = setTimeout(() => reject(new Error('server startup timeout')),10000);
        child.once('error',reject); child.once('message',message => {clearTimeout(timeout);resolve(message);});
      });
    } finally { child.kill(); }
  }
  const policy = await launch('policy'), baseline = await launch('baseline');
  assert.notEqual(policy.pid,baseline.pid);
  assert.equal(policy.config.predictive.downgrade.enabled,false);
  assert.equal(baseline.config.predictive.downgrade.enabled,require('../../src/config').predictive.downgrade.enabled);
});

test('idle pool retirement prevents reuse at a controlled peer-reset boundary without retries', async () => {
  async function fixture(agent, label) {
    const { performance } = require('perf_hooks');
    const start = performance.now(), now = () => performance.now()-start;
    const client = transportObserver(now), peer = transportObserver(now), entries = [];
    let firstPeerSocket;
    const server = http.createServer((req,res) => {
      entries.push(req.url); peer.assign(req.socket,req.url);
      firstPeerSocket ||= req.socket;
      req.resume(); res.end(JSON.stringify({status:200}));
    });
    server.on('connection',socket=>peer.track(socket));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const request = id => new Promise(resolve => {
      const row = {requestId:id,attempts:1,dispatchMs:now()};
      const req = http.get({host:'127.0.0.1',port:server.address().port,path:'/'+id,agent},res=>{
        row.keepAliveHint=res.headers['keep-alive'];res.resume();
        res.on('end',()=>{row.status=res.statusCode;row.endMs=now();});
      });
      req.on('socket',socket=>{row.reusedSocket=req.reusedSocket;row.socketId=client.assign(socket,id,{reusedSocket:req.reusedSocket});});
      req.on('error',error=>{row.code=error.code;row.message=error.message;row.endMs=now();});
      req.once('close',()=>resolve(row));
    });
    try {
      const first=await request('first'); await new Promise(resolve=>setImmediate(resolve));
      const freeBefore=Object.values(agent.freeSockets).flat().map(socket=>({timeoutMs:socket.timeout||0}));
      // Accelerated idle expiry. Issue the second request in the same callback
      // as peer reset, before its socket-close event can remove a stale pool entry.
      // This is a controlled lifecycle test, not a replay of a benchmark trace.
      await new Promise(resolve=>setTimeout(resolve,140));
      const peerAlreadyClosed=firstPeerSocket.destroyed;
      const freeAtBoundary=Object.values(agent.freeSockets).flat().length;
      if (!peerAlreadyClosed) {
        peer.event(firstPeerSocket,'fixture_peer_reset'); firstPeerSocket.resetAndDestroy();
      }
      const second=await request('second'); await new Promise(resolve=>setImmediate(resolve));
      const evidence={label,agent:agentConfig(agent),server:serverConfig(server),first,second,
        freeBefore,freeAtBoundary,peerAlreadyClosed,entries,client:{sockets:client.sockets,events:client.events},
        peer:{sockets:peer.sockets,events:peer.events},
        limitation:'Forced reset and accelerated 40 ms idle retirement demonstrate a mechanism; historical socket identity/closure is unavailable.'};
      if(process.env.BENCH_TRANSPORT_DIAGNOSTICS) write(path.join(process.env.BENCH_TRANSPORT_DIAGNOSTICS,label+'.json'),evidence);
      return evidence;
    } finally { agent.destroy(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  }
  const original=await fixture(new http.Agent({keepAlive:true,maxSockets:16384,maxFreeSockets:256}),'original-pool');
  assert.equal(original.freeBefore[0].timeoutMs,0);
  assert.equal(original.freeAtBoundary,1); assert.equal(original.peerAlreadyClosed,false);
  assert.equal(original.second.reusedSocket,true); assert.equal(original.second.code,'ECONNRESET');
  assert.deepEqual(original.entries,['/first']); assert.equal(original.second.attempts,1);
  const corrected=await fixture(new BenchmarkAgent(16384,40),'idle-retirement');
  assert.equal(corrected.freeBefore[0].timeoutMs,40); assert.equal(corrected.freeAtBoundary,0);
  assert.equal(corrected.peerAlreadyClosed,true); assert.equal(corrected.second.reusedSocket,false);
  assert.equal(corrected.second.status,200); assert.equal(corrected.second.attempts,1);
  assert.deepEqual(corrected.entries,['/first','/second']);
});

test('reused active response outlives free-socket timeout and keeps one request attempt', async () => {
  const agent=new BenchmarkAgent(2,40); let requests=0;
  const server=http.createServer((req,res)=>{requests++;req.resume();
    setTimeout(()=>res.end('ok'),requests===1 ? 0 : 120);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const get=()=>new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port:server.address().port,agent},res=>{res.resume();res.on('end',()=>resolve({reused:req.reusedSocket,timeoutMs:req.socket.timeout}));});
    req.on('error',reject);
  });
  try {
    await get(); await new Promise(resolve=>setImmediate(resolve));
    const result=await get(); assert.equal(result.reused,true);
    assert.equal(result.timeoutMs,0); assert.equal(requests,2);
  } finally {agent.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('short peer keep-alive hints are respected and client diagnostics correlate socket reuse', async () => {
  const agent=new BenchmarkAgent(2);
  const socket={setKeepAlive(){},unref(){},setTimeout(value){this.timeout=value;},timeout:0,
    _httpMessage:{res:{headers:{'keep-alive':'timeout=3'}}}};
  assert.equal(agent.keepSocketAlive(socket),true);assert.equal(socket.timeout,2000);
  socket._httpMessage.res.headers['keep-alive']='timeout=1';
  assert.equal(agent.keepSocketAlive(socket),false);agent.destroy();
  const server=http.createServer((req,res)=>{req.resume();res.end(JSON.stringify({status:200}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const input={durationSec:.1,hash:'same',requests:[0,70].map((arrivalOffsetMs,i)=>({requestId:String(i),arrivalOffsetMs}))};
    const result=await load({input,port:server.address().port,drainSec:1});
    assert.equal(result.rows[0].reusedSocket,false);assert.equal(result.rows[1].reusedSocket,true);
    assert.equal(result.rows[0].socketId,result.rows[1].socketId);
    assert.deepEqual(result.rows.map(r=>r.attempts),[1,1]);
    assert.equal(result.transport.agent.freeSocketTimeoutMs,4000);
    assert.ok(result.transport.events.some(e=>e.kind==='connect'));
    assert.equal(result.transport.sockets[0].assignments.length,2);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
