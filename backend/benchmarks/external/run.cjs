'use strict';
const path=require('path');const os=require('os');const {randomUUID}=require('crypto');
const {root,write}=require('../controlled/common.cjs');
const {makeTrace,LIMITS}=require('./trace.cjs');const {load}=require('./load.cjs');
function parse(argv){
  const o={profile:'mixed',rates:[10,25,50],durationSec:5,seed:42,drainSec:300,maxOutstanding:128};
  const flags={'--url':'url','--profile':'profile','--rates':'rates','--duration':'durationSec','--seed':'seed','--drain':'drainSec','--max-outstanding':'maxOutstanding'};
  for(let i=0;i<argv.length;i+=2){const key=flags[argv[i]],v=argv[i+1];if(!key||v==null)throw new Error(`Unknown/missing option ${argv[i]}`);o[key]=key==='rates'?v.split(',').map(Number):['url','profile'].includes(key)?v:Number(v);}
  const u=new URL(o.url);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw new Error('Use the gateway origin URL without credentials, path, query or fragment');
  o.url=u.origin;
  if(!o.rates.length||o.rates.length>3||new Set(o.rates).size!==o.rates.length||o.rates.some(r=>!Number.isFinite(r)||r<=0||r>LIMITS.maxRate)||
    !Number.isFinite(o.durationSec)||o.durationSec<=0||o.durationSec>LIMITS.maxDurationSec||!Number.isSafeInteger(o.seed)||
    !Number.isFinite(o.drainSec)||o.drainSec<0||o.drainSec>LIMITS.maxDrainSec||!Number.isInteger(o.maxOutstanding)||o.maxOutstanding<1||o.maxOutstanding>LIMITS.maxOutstanding)throw new Error('External demo limits: at most three rates up to 100/s, duration up to 30s, outstanding up to 512, drain up to 300s');
  if(!Object.hasOwn(require('../../src/config').simulator.profiles,o.profile))throw new Error('Unknown workload profile');
  return o;
}
async function json(url,body){const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(640000)});const data=await r.json();if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);return data;}
async function run(o){
  const dir=path.join(root,'backend/experiments',`external-client-${new Date().toISOString().replaceAll(':','-')}-${randomUUID().slice(0,8)}`);
  write(path.join(dir,'config.json'),{...o,environment:{node:process.version,platform:os.platform(),architecture:os.arch()},noRetries:true});
  console.log(`Evidence: ${dir}`);
  try{
    const health=await json(`${o.url}/api/health`);write(path.join(dir,'health.json'),health);
    for(const rate of o.rates){
      const input=makeTrace({...o,rate});const rateDir=path.join(dir,String(rate));write(path.join(rateDir,'trace.json'),input);
      const session=await json(`${o.url}/api/external/runs`,{trace:input,drainSec:o.drainSec});write(path.join(rateDir,'session.json'),session);
      let state;
      for(const arm of ['baseline','predictive']){
        console.log(`${rate} requests/s | ${arm} | ${input.requests.length} identical offers`);
        await json(`${o.url}/api/external/runs/${session.id}/${arm}/begin`,{});
        const client=await load({input,url:`${o.url}/api/external/runs/${session.id}/${arm}/execute`,maxOutstanding:o.maxOutstanding,drainSec:o.drainSec});
        write(path.join(rateDir,`${arm}-client.json`),client);
        state=await json(`${o.url}/api/external/runs/${session.id}/${arm}/finish`,client);write(path.join(rateDir,`${arm}-result.json`),state);
        const summary=state.summaries[arm];console.log(`${arm}: completed ${summary.counts.completed}/${summary.counts.offered}, rejected ${summary.counts.rejected}, failures ${summary.counts.failed}, transport ${summary.counts.transportErrors}, dispatch p99 ${summary.dispatchLatenessMs.p99?.toFixed(2)} ms | ${summary.valid?'VALID':'INVALID'}`);
        if(!summary.valid||!['baseline-complete','complete'].includes(state.state))break;
      }
      const report=await json(`${o.url}/api/external/runs/${session.id}/report`);write(path.join(rateDir,'report.json'),report);
      if(state?.state!=='complete'){write(path.join(dir,'STOPPED.json'),{rate,state});console.error('Stopped at the first invalid arm. No retry or next rate.');return {directory:dir,valid:false};}
      write(path.join(rateDir,'comparison.json'),state.comparison);
    }
    write(path.join(dir,'COMPLETE.json'),{rates:o.rates,valid:true});return {directory:dir,valid:true};
  }catch(error){write(path.join(dir,'FAILED.json'),{error:error.message});throw error;}
}
if(require.main===module){Promise.resolve().then(()=>run(parse(process.argv.slice(2)))).then(r=>{if(!r.valid)process.exitCode=1;}).catch(error=>{console.error(error.message);process.exitCode=1;});}
module.exports={parse,run};
