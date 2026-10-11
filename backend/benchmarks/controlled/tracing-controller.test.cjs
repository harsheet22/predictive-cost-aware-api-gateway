'use strict';
// No runtime adapter is invoked. Every stop command uses a recording fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { root } = require('./common.cjs');
const { TRACE, LIMITS, parseController, diagnosticCommand, validateOriginal, within, stopReason,
  identifyNetwork, identifyCpu, ownership, captureIssues, stopOwned } = require('./tracing-controller.cjs');
const net = { name: 'GatewayNetUnique', handle: '1', guid: 'g1', file: 'C:\\capture\\network.etl' };
const cpu = { name: 'WPR_CPUUnique_Main', handle: '2', guid: 'g2', file: 'C:\\capture\\temp\\raw.etl' };
const owned = { network: net, cpu: { instance: 'CPUUnique', file: 'C:\\capture\\cpu.etl', sessions: [cpu] } };
function fake(fail = false) {
  const commands = [], events = [];
  return { commands, events, runtime: { cleanupVerified: true, async command(executable, args) { commands.push({ executable, args });
    if (fail) throw new Error('fixture finalization failure'); } }, event: value => events.push(value) };
}
test('controller requires explicit execution and rejects benchmark/policy overrides', () => {
  assert.throws(() => parseController([]), /execute/);
  for (const args of [['--execute','--execute'], ['--execute','--arm','predictive'], ['--execute','--mode','full'],
    ['--execute','--trace','another.json'], ['--execute','--duration','1'], ['--execute','--window','120'],
    ['--execute','--output-parent']]) assert.throws(() => parseController(args));
  assert.throws(() => parseController(['--execute','--output-parent',root]), /outside/);
  const result = parseController(['--execute','--output-parent',path.join(path.dirname(root),'diagnostic-fixture')]);
  assert.ok(result.outputParent.endsWith('diagnostic-fixture'));
});
test('exact command selects only A/baseline and saved original trace with unchanged drain', () => {
  assert.deepEqual(diagnosticCommand().slice(1), ['--mode','diagnostic','--experiment','A','--arm','baseline','--trace',TRACE,'--drain','300','--expected-trace-sha256','0b5fd16adda0997854d8d1063272b59ccee50399503a428e202847116f1eb1ff']);
  assert.equal(diagnosticCommand().filter(s => s === 'baseline').length, 1);
  assert.equal(diagnosticCommand().includes('predictive'), false);
});
test('trace validation locks original file hash, request hash, seed, horizon and request count', () => {
  const saved = { evidence: { sourceFileSha256: '0b5fd16adda0997854d8d1063272b59ccee50399503a428e202847116f1eb1ff' },
    input: { hash: '3800f59c247d331243145f325ba203490b41d45a37bbe3721cf7e4fe5871cd66',
      profile: 'overload', seed: 42, durationSec: 60, requests: Array(29938) } };
  assert.doesNotThrow(() => validateOriginal(saved));
  for (const [key,value] of [['seed',43],['durationSec',1],['profile','demo'],['hash','wrong'],['requests',[]]]) {
    assert.throws(() => validateOriginal({ ...saved, input: {...saved.input,[key]:value} }), /identity changed/);
  }
  assert.throws(() => validateOriginal({...saved,evidence:{sourceFileSha256:'wrong'}}));
});
test('time, storage, free-space, completion and disconnect stop conditions are independent', () => {
  const healthy = { elapsedMs: 1, bytes: 0, freeBytes: LIMITS.initialFreeBytes };
  assert.equal(stopReason(healthy), null);
  assert.equal(stopReason({...healthy,elapsedMs:90000}), 'time_threshold');
  assert.equal(stopReason({...healthy,bytes:LIMITS.stopBytes}), 'storage_threshold');
  assert.equal(stopReason({...healthy,networkBytes:(LIMITS.networkMaxMiB-32)*1024**2}), 'network_storage_threshold');
  assert.equal(stopReason({...healthy,freeBytes:LIMITS.minimumFreeBytes+LIMITS.finalizationHeadroomBytes-1}), 'free_space_guard');
  assert.equal(stopReason({...healthy,armFinished:true}), 'arm_finished');
  assert.equal(stopReason({...healthy,disconnected:true}), 'controller_disconnected');
  assert.equal(stopReason({...healthy,elapsedMs:89999,bytes:LIMITS.stopBytes-1}), null);
});
test('path boundaries exclude similarly prefixed sibling folders', () => {
  assert.equal(within('C:\\capture','C:\\capture\\temp\\raw.etl'), true);
  assert.equal(within('C:\\capture','C:\\capture-other\\raw.etl'), false);
});
test('network ownership requires new exact name and private output path', () => {
  assert.deepEqual(identifyNetwork([], [net], net.name, net.file), net);
  assert.throws(() => identifyNetwork([net], [net], net.name, net.file));
  assert.throws(() => identifyNetwork([], [net,net], net.name, net.file));
  assert.throws(() => identifyNetwork([], [{...net,file:'C:\\other.etl'}], net.name, net.file));
});
test('CPU ownership requires every matched instance session to be new and inside its temp directory', () => {
  assert.deepEqual(identifyCpu([], [cpu], 'CPUUnique', 'C:\\capture\\temp'), [cpu]);
  assert.throws(() => identifyCpu([cpu], [cpu], 'CPUUnique', 'C:\\capture\\temp'));
  assert.throws(() => identifyCpu([], [{...cpu,file:'C:\\other.etl'}], 'CPUUnique', 'C:\\capture\\temp'));
  assert.throws(() => identifyCpu([], [], 'CPUUnique', 'C:\\capture\\temp'));
});
test('replaced session handle, GUID or output is ambiguous even with the same name', () => {
  assert.equal(ownership(net,[net]), 'owned'); assert.equal(ownership(net,[]), 'absent');
  for (const key of ['handle','guid','file']) assert.equal(ownership(net,[{...net,[key]:'replaced'}]), 'ambiguous');
});
test('capture loss and unexpected disappearance are reported separately from benchmark validity', () => {
  assert.deepEqual(captureIssues(owned,[net,cpu]),[]);
  const issues=captureIssues(owned,[{...net,eventsLost:3}]);
  assert.ok(issues.some(x=>x.issue==='eventsLost' && x.count===3));
  assert.ok(issues.some(x=>x.issue==='capture_session_absent' && x.session===cpu.name));
});
test('cleanup targets only verified named network session and unique WPR instance', async () => {
  const f = fake(); const result = await stopOwned(owned,[net,cpu,{name:'UnrelatedRecorder'}],f.runtime,f.event);
  assert.deepEqual(result,{blocked:false,failed:false});
  assert.deepEqual(f.commands[0],{executable:'logman.exe',args:['stop',net.name,'-ets']});
  assert.equal(f.commands[1].executable,'wpr.exe');
  assert.deepEqual(f.commands[1].args.slice(-2),['-instancename','CPUUnique']);
  assert.equal(f.commands.some(c => c.executable === 'netsh.exe'),false);
});
test('ambiguous ownership never stops foreign recordings', async () => {
  const f=fake(); const result=await stopOwned(owned,[{...net,handle:'foreign'},{...cpu,guid:'foreign'}],f.runtime,f.event);
  assert.equal(result.blocked,true); assert.deepEqual(f.commands,[]);
  assert.equal(f.events.filter(e=>e.kind==='cleanup_blocked').length,2);
});
test('already absent sessions cause no stop commands or cancellation', async () => {
  const f=fake(); await stopOwned(owned,[],f.runtime,f.event); assert.deepEqual(f.commands,[]);
});
test('additional or partially missing WPR sessions block instance-wide stop', async () => {
  const f=fake(); await stopOwned(owned,[net,cpu,{...cpu,name:'WPR_CPUUnique_Unexpected',handle:'3'}],f.runtime,f.event);
  assert.equal(f.commands.length,1); assert.equal(f.commands[0].executable,'logman.exe');
  const g=fake(); await stopOwned({...owned,cpu:{...owned.cpu,sessions:[cpu,{...cpu,name:'WPR_CPUUnique_Second'}]}},[net,cpu],g.runtime,g.event);
  assert.equal(g.commands.length,1);
});
test('finalization errors are reported without retry, cancel or deleting partial evidence', async () => {
  const f=fake(true); const result=await stopOwned(owned,[net,cpu],f.runtime,f.event);
  assert.equal(result.failed,true); assert.equal(f.commands.length,2);
  assert.equal(f.events.filter(e=>e.kind==='stop_error').length,2);
  assert.ok(f.commands.every(c=>!c.args.includes('-cancel')));
});
test('controller/watchdog never kill benchmark processes or delete artifacts', () => {
  for (const name of ['tracing-controller.cjs','tracing-watchdog.cjs']) {
    const source=fs.readFileSync(path.join(__dirname,name),'utf8');
    assert.doesNotMatch(source,/\.kill\(|taskkill|rmSync\(|unlinkSync\(/);
  }
});

const { EventEmitter } = require('events');
const { safeSink, validateDisk, validatePermissions, classifySessions, launchState, superviseWatchdog } = require('./tracing-safety.cjs');
const { commandRunner } = require('./tracing-runtime.cjs');
const { watch } = require('./tracing-watchdog.cjs');
const { recoverOwned, assertLiveCaptureReviewed } = require('./tracing-controller.cjs');

test('live capture and unverified cleanup are blocked without a CLI bypass', async () => {
  assert.throws(assertLiveCaptureReviewed, /Live capture blocked/);
  const f=fake(); f.runtime.cleanupVerified=false;
  assert.equal((await stopOwned(owned,[net,cpu],f.runtime,f.event)).blocked,true);
  assert.equal(f.commands.length,0);
});
test('logging exceptions cannot prevent independently verified owned cleanup', async () => {
  const f=fake(); const fallback=[];
  const emit=safeSink(()=>{throw Error('ENOSPC');},value=>fallback.push(value));
  const result=await stopOwned(owned,[net,cpu],f.runtime,emit);
  assert.equal(result.failed,false); assert.equal(f.commands.length,2);
  assert.equal(emit.failed(),true); assert.ok(fallback.length);
});
test('synchronous native stop failure still permits the other owned cleanup', async () => {
  const commands=[];
  const result=await stopOwned(owned,[net,cpu],{cleanupVerified:true,command(exe){commands.push(exe);if(exe==='logman.exe')throw Error('interrupted');}},()=>{});
  assert.equal(result.failed,true); assert.deepEqual(commands,['logman.exe','wpr.exe']);
});
test('invalid disk and timing measurements fail closed', () => {
  for(const freeBytes of [undefined,null,NaN,Infinity,-1,'5000000000']) {
    assert.throws(()=>validateDisk({freeBytes,volume:'C:/',localFixed:true}));
    assert.equal(stopReason({elapsedMs:1,bytes:0,freeBytes}),'observation_error');
  }
  assert.throws(()=>validateDisk({freeBytes:1,volume:'C:/',localFixed:false}));
  assert.throws(()=>validatePermissions({private:false,ownerSid:'owner',rules:[{}]}));
  assert.throws(()=>validatePermissions({private:true}));
});
test('original snapshot distinguishes unchanged, replaced and unknown sessions', () => {
  const old={name:'Other',handle:'7',guid:'old',file:'C:/other.etl'};
  const delta=classifySessions([old],[old,net,{...old,handle:'8'}, {name:'Unmapped',handle:'9'}],owned);
  assert.deepEqual(delta.map(x=>x.ownership),['identified','unknown','unknown']);
  assert.throws(()=>identifyNetwork([net],[net],net.name,net.file));
});
for(const kind of ['stopping','stopped','startup_failed','watchdog_failed','cancel']) {
  test(`launch authorization is revoked by ${kind}, including after readiness`,()=>{
    const state=launchState();state.update({kind:'ready'});assert.equal(state.canLaunch(true),false);
    state.update({kind:'launch_authorized'});assert.equal(state.canLaunch(true),true);
    kind==='cancel'?state.cancel():state.update({kind});
    assert.equal(state.canRequest(true),false);assert.equal(state.canLaunch(true),false);
    state.update({kind:'ready'});state.update({kind:'launch_authorized'});assert.equal(state.canLaunch(true),false);
  });
}
test('watchdog failure triggers immediate independent recovery without a benchmark operation', async()=>{
  const child=new EventEmitter(), state=launchState();let recovery=0,ledger;
  state.update({kind:'ready'});state.update({kind:'launch_authorized'});
  const monitor=superviseWatchdog(child,state,async()=>{recovery++;},value=>{ledger=value;},()=>{});
  child.emit('message',{kind:'ledger',ledger:{owned}});child.emit('exit',1,null);
  assert.equal(state.canLaunch(true),false);await monitor.recovery();assert.equal(recovery,1);assert.deepEqual(ledger,{owned});
  child.emit('error',Error('duplicate'));await monitor.recovery();assert.equal(recovery,1);
});
test('recovery leaves unknown sessions untouched and reports cleanup blockers',async()=>{
  const f=fake();f.runtime.sessions=async()=>[net,cpu,{name:'Unknown'}];
  const result=await recoverOwned({before:[],owned},f.runtime,f.event);
  assert.equal(result.blocked,true);assert.equal(f.commands.length,2);
  assert.ok(f.commands.every(x=>!x.args.includes('Unknown')));
});
function nativeFixture(outcome) {
  const events=[];let expire,callback,killed=0;
  const execute=(exe,args,options,cb)=>{callback=cb;assert.equal(options.timeout,undefined);return {kill(signal){killed++;assert.equal(signal,'SIGTERM');}};};
  const command=commandRunner(x=>events.push(x),execute,()=>12,{setTimeout(fn){expire=fn;return 1;},clearTimeout(){}});
  const promise=command('fixture.exe',['C:/path with spaces'],15);
  return {events,promise,finish:()=>callback(outcome,'out','err'),expire:()=>expire(),killed:()=>killed};
}
test('native timeout and interrupted finalization record signal and status separately',async()=>{
  const f=nativeFixture(Object.assign(Error('terminated'),{signal:'SIGTERM',killed:true,code:null}));
  f.expire();f.finish();await assert.rejects(f.promise,error=>error.result.timedOut && error.result.signal==='SIGTERM' && error.result.exitCode===null);
  assert.equal(f.killed(),1);
});
test('native spawn and exit failures are distinct and retained',async()=>{
  const spawn=nativeFixture(Object.assign(Error('missing'),{code:'ENOENT',syscall:'spawn fixture.exe'}));spawn.finish();
  await assert.rejects(spawn.promise,error=>error.result.spawnError.code==='ENOENT' && error.result.exitCode===null && !error.result.timedOut);
  const exit=nativeFixture(Object.assign(Error('failed'),{code:23}));exit.finish();
  await assert.rejects(exit.promise,error=>error.result.exitCode===23 && error.result.spawnError===null && !error.result.timedOut);
});
test('native command settlement survives journal failure',async()=>{
  let callback;
  const command=commandRunner(()=>{throw Error('disk full');},(exe,args,opts,cb)=>{callback=cb;return {kill(){assert.fail('unexpected timeout');}};},()=>0,{setTimeout(){return 1;},clearTimeout(){}});
  const promise=command('fixture.exe',[]);callback(null,'ok','');assert.equal((await promise).exitCode,0);
});
function watchdogFixture(options={}) {
  const host=new EventEmitter();host.pid=123;host.connected=true;host.messages=[];
  host.send=(msg,cb)=>{host.messages.push(structuredClone(msg));cb?.();};host.disconnect=()=>{host.connected=false;host.emit('disconnect');};
  const before=[{name:'Unrelated',handle:'7',guid:'u',file:'C:/unrelated.etl'}], sessions=[...before], commands=[],events=[],fallback=[];
  let stamp=0, tick, closed=false;
  const io={mkdirSync(){},writeFileSync(){if(options.failWrites)throw Error('ENOSPC');},existsSync(){return false;},statSync(){return {size:0};}};
  const runtime={captureVerified:true,cleanupVerified:true,
    permissions:async()=>({private:options.private!==false,ownerSid:'owner',rules:[{}]}),
    disk:async()=>({freeBytes:LIMITS.initialFreeBytes,volume:'mounted-volume',localFixed:true}),
    sessions:async()=>structuredClone(sessions),close(){closed=true;},
    async command(exe,args){
      commands.push({exe,args});
      if(exe==='netsh.exe' && args[1]==='start'){
        sessions.push({name:args.find(x=>x.startsWith('sessionname=')).slice(12),file:args.find(x=>x.startsWith('tracefile=')).slice(10),handle:'1',guid:'net'});
        if(options.cancelStartup)host.emit('message',{kind:'stop',reason:'cancelled'});
        if(options.failAfterNetwork)throw Error('network command interrupted');
      }
      if(exe==='wpr.exe' && args[0]==='-start'){
        const instance=args.at(-1),temp=args[args.indexOf('-recordtempto')+1];
        sessions.push({name:options.unknownCpu?'UnmappedCpu':`WPR_${instance}_Main`,file:path.join(temp,'raw.etl'),handle:'2',guid:'cpu'});
        if(options.unknownCpu)throw Error('WPR interrupted');
      }
      if(args[0]==='stop' || args[0]==='-stop'){
        if(options.failStop)throw Error('fixture finalization failure');
        if(exe==='logman.exe')sessions.splice(sessions.findIndex(s=>s.name===args[1]),1);
        else {const index=sessions.findIndex(s=>s.name.includes(args.at(-1)));if(index>=0)sessions.splice(index,1);}
      }
      return {stdout:args[2]==='status'?'No trace session is in progress':args[0]==='-status'?'There are no trace profiles running.':'CSwitch ReadyThread SampledProfile',stderr:''};
    }};
  const deps={host,io,runtime,now:()=>stamp,interval(fn){tick=fn;return 1;},cancelInterval(){},bytesIn:()=>options.bytes || 0,
    event(value){events.push(value);if(options.failLogs && value.kind==='stop_trigger')throw Error('EACCES');},fallback:value=>fallback.push(value)};
  return {host,before,sessions,commands,events,fallback,deps,setTime:n=>{stamp=n;},tick:()=>tick?.(),closed:()=>closed};
}
for(const name of ['failLogs','failWrites','failStop','cancelStartup','failAfterNetwork','unknownCpu']) {
  test(`watchdog handles ${name} without real tracing or replay`,async()=>{
    const f=watchdogFixture({[name]:true});const handle=await watch('C:/capture',f.deps);
    await handle.stop('fixture_finished');
    assert.equal(f.closed(),true);
    if(name==='failLogs')assert.equal(f.commands.filter(c=>c.exe==='logman.exe' && c.args[0]==='stop').length,1);
    if(name==='failWrites')assert.equal(f.commands.some(c=>c.args.includes('start')),false);
    if(['cancelStartup','failAfterNetwork','unknownCpu'].includes(name))assert.equal(f.host.messages.some(m=>m.kind==='ready'),false);
    if(name==='unknownCpu') {
      const unknown=f.events.filter(e=>e.kind==='session_delta').flatMap(e=>e.delta).find(x=>x.session.name==='UnmappedCpu');
      assert.equal(unknown.ownership,'unknown');assert.ok(f.sessions.some(s=>s.name==='UnmappedCpu'));
    }
    const ledger=f.host.messages.find(m=>m.kind==='ledger' && m.ledger.preflightComplete);
    assert.deepEqual(ledger.ledger.before,f.before);
  });
}
test('watchdog finalization records overshoot and preserves unknown concurrent sessions',async()=>{
  const f=watchdogFixture({bytes:LIMITS.stopBytes+1024});const handle=await watch('C:/capture',f.deps);
  f.sessions.push({name:'ConcurrentOther',handle:'99',guid:'other',file:'C:/elsewhere'});f.setTime(90020);
  await handle.stop('fixture_finished');
  const final=f.events.find(x=>x.kind==='finalization_observation');
  assert.equal(final.timeOvershootMs,20);assert.equal(final.storageOvershootBytes,1024);
  assert.ok(f.sessions.some(x=>x.name==='ConcurrentOther'));assert.equal(f.host.exitCode,1);
});
test('permission failure prevents all capture-start commands',async()=>{
  const f=watchdogFixture({private:false});const handle=await watch('C:/capture',f.deps);await handle.stop('fixture_finished');
  assert.equal(f.commands.length,0);assert.equal(f.host.messages.some(x=>x.kind==='ready'),false);
});


test('disk writes failing after capture startup still permit verified cleanup and preserve IPC ledger',async()=>{
  const f=watchdogFixture();const handle=await watch('C:/capture',f.deps);
  f.deps.io.writeFileSync=()=>{throw Error('ENOSPC during finalization');};
  await handle.stop('fixture_finished');
  assert.equal(f.commands.filter(x=>x.exe==='logman.exe' && x.args[0]==='stop').length,1);
  assert.equal(f.commands.filter(x=>x.exe==='wpr.exe' && x.args[0]==='-stop').length,1);
  assert.ok(f.host.messages.some(x=>x.kind==='ledger' && x.ledger.owned.network && x.ledger.owned.cpu));
  assert.equal(f.host.exitCode,1);assert.equal(f.closed(),true);
});
test('unexpected watchdog IPC loss is an immediate failure but orderly stopping is not',async()=>{
  for(const stopping of [false,true]) {
    const child=new EventEmitter(),state=launchState();let failures=0;
    state.update({kind:'ready'});if(stopping)state.update({kind:'stopping'});
    const monitor=superviseWatchdog(child,state,async()=>{failures++;},()=>{},()=>{});
    child.emit('disconnect');await monitor.recovery();assert.equal(failures,stopping?0:1);
    assert.equal(state.canLaunch(false),false);
  }
});
test('readiness cannot authorize a stopping watchdog and finalization observations continue',async()=>{
  const f=watchdogFixture();const handle=await watch('C:/capture',f.deps);
  f.host.emit('message',{kind:'stop',reason:'cancelled'});
  f.host.emit('message',{kind:'authorize_launch'});await handle.stop('fixture_finished');
  assert.equal(f.host.messages.some(x=>x.kind==='launch_authorized'),false);
  assert.ok(f.events.some(x=>x.kind==='watch_sample' && x.finalizing));
});
test('free-space probe resolves the actual volume and ACL probe is read-only',()=>{
  const source=fs.readFileSync(path.join(__dirname,'tracing-session-probe.ps1'),'utf8');
  assert.match(source,/GetVolumePathNameW/);assert.match(source,/GetDiskFreeSpaceExW/);
  assert.doesNotMatch(source,/GetPathRoot|Set-Acl|Start-Process|RunAs/);
});
