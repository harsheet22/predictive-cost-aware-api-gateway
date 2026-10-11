'use strict';
const HashPrefixCache = require('../src/workload/hashPrefixCache');
const jobs = require('../src/workload/jobs');
const { execute } = require('../src/workload/executor');
const { DecisionEngine } = require('../src/decision/decisionEngine');
const PredictiveGateway = require('../src/gateways/predictiveGateway');
const MetricsStore = require('../src/metrics/metricsStore');
const config = require('../src/config');
const PredictionQueue = require('../src/ml/predictionQueue');
const base = { requestId: 'exact', type: 'hash_compute', payloadSize: 256,
  precision: 'full', priority: 'normal', parameters: { itemId: 1 } };
const prediction = { predictedCostMs: 30, predictedCloudCostUsd: .000001,
  costTier: 'cheap', modelVersion: 'test', confidence: .9, timings: { httpMs: 100 } };

test('completion mode treats forecasts as advisory but retains hard capacity and expiry', async () => {
  let now=0;const queue=new PredictionQueue(1,{normalWaitMs:100,highWaitMs:100,maxWaiting:1,rejectOnEstimate:false,now:()=>now});
  let release;const blocked=new Promise(r=>{release=r;});const active=queue.run(()=>blocked);
  for(let i=0;i<10;i++)queue.recordHttpSuccess(1000);
  const task=jest.fn();const waiting=queue.run(task);
  const expired=expect(waiting).rejects.toMatchObject({reason:'prediction_queue_expired'});
  expect(queue.stats().queued).toBe(1);
  await expect(queue.run(jest.fn())).rejects.toMatchObject({reason:'prediction_queue_full'});
  now=100;release();await active;await expired;
  expect(task).not.toHaveBeenCalled();expect(queue.stats()).toMatchObject({running:0,queued:0});
});

test('prefix reuse matches fresh hashes for growing, shrinking, repeated and unrelated work', async () => {
  const cache = new HashPrefixCache();
  for (const seed of ['item:1','item:2','another']) {
    for (const count of [1200, 7000, 500, 2300, 7000, 1200, 8000]) {
      expect((await cache.run(count, seed)).digest).toBe(jobs.hashRounds(count, seed));
    }
  }
  expect(cache.stats().reusedIterations).toBeGreaterThan(0);
  expect(cache.stats().computedIterations + cache.stats().reusedIterations).toBe(cache.stats().requestedIterations);
});

test('CPU cache is bounded and eviction cannot change results', async () => {
  const cache = new HashPrefixCache({ maxSeeds: 2, maxCheckpointsPerSeed: 2, checkpointIterations: 100 });
  for (const seed of ['a','b','c','a']) expect((await cache.run(1100, seed)).digest).toBe(jobs.hashRounds(1100, seed));
  expect(cache.seeds.size).toBe(2);
  expect(Array.from(cache.seeds.values()).every(c => c.size <= 2)).toBe(true);
});

test('concurrent reuse across yielded hash chunks remains exact', async () => {
  const saved = config.executor.syncIterationCap; config.executor.syncIterationCap = 512;
  try {
    const cache = new HashPrefixCache();
    const counts=[3000,5000,4500];
    const results=await Promise.all(counts.map(n=>cache.run(n,'shared')));
    results.forEach((r,i)=>expect(r.digest).toBe(jobs.hashRounds(counts[i],'shared')));
  } finally { config.executor.syncIterationCap = saved; }
});

test.each(Object.keys(config.requestTypes))('exact optimization keeps full precision and fresh I/O for %s', async type => {
  const cache = new HashPrefixCache(); const request = { ...base, type };
  const first = await execute(request, { hashPrefixCache: cache });
  const second = await execute(request, { hashPrefixCache: cache });
  expect(second).toMatchObject({ precision: 'full', iterations: first.iterations, ioMs: first.ioMs,
    output: first.output, cpuIterationsExecuted: 0, cpuIterationsReused: first.iterations });
  expect(second.wallMs).toBeGreaterThanOrEqual(first.ioMs - 2);
  expect(second.actualCloudCostUsd).toBeGreaterThan(0);
});

test.each(Object.keys(config.requestTypes))('quality policy respects nature and priority for %s', async type => {
  const engine = new DecisionEngine({ predict: async()=>prediction }, { remainingUsd: ()=>.001 });
  for (const priority of ['low','normal','high']) {
    const request={...base,type,priority};
    const result=await engine.decide(request,{concurrent:0});
    const eligible=priority==='low'&&config.predictive.optimization.reducedQualityTypes.includes(type);
    expect(result.decision).toBe(eligible?'DOWNGRADE':'ALLOW');
    if(eligible) expect(result.reason).toBe('low_priority_reduced_quality');
    else expect(engine._canDowngrade(request)).toBe(false);
  }
});

test('completion-oriented defaults accept bounded waiting beyond the old SLA cutoff', async () => {
  const metrics = new MetricsStore('completion'); const gateway = new PredictiveGateway(metrics);
  let release; const blocked = new Promise(resolve=>{release=resolve;});
  gateway.mlClient.predict = jest.fn(async()=>{await blocked;return prediction;});
  try {
    const pending = Array.from({length:6},(_,i)=>gateway.handle({...base,requestId:String(i)}));
    expect(gateway.predictionQueue.stats()).toMatchObject({ running:2, queued:4, maxWaiting:4096 });
    release(); const results=await Promise.all(pending);
    expect(results.every(r=>r.status===200&&r.precision==='full')).toBe(true);
    expect(metrics.snapshot()).toMatchObject({ incoming:6, processed:6, rejected:0,inFlight:0, ml:{successCount:6,errorCount:0} });
  } finally { release(); clearInterval(metrics._timer); }
});

test('low-priority reduced execution keeps fresh I/O and exposes actual CPU reuse', async () => {
  const metrics=new MetricsStore('quality');const gateway=new PredictiveGateway(metrics);
  gateway.mlClient.predict=jest.fn(async()=>prediction);
  try {
    const request={...base,type:'image_resize',priority:'low'};
    const a=await gateway.handle(request);const b=await gateway.handle(request);
    expect(a).toMatchObject({decision:'DOWNGRADE',reason:'low_priority_reduced_quality',precision:'reduced',cached:false});
    expect(b.optimization.cpuIterationsReused).toBeGreaterThan(0);
    expect(metrics.snapshot()).toMatchObject({processed:2,rejected:0,inFlight:0});
  } finally {clearInterval(metrics._timer);}
});
