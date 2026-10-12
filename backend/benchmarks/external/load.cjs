'use strict';
const http=require('http'); const https=require('https');
const {performance}=require('perf_hooks');
const {scheduleAbsolute}=require('../controlled/loadgen.cjs');
const {BenchmarkAgent,transportObserver,agentConfig}=require('../controlled/http-transport.cjs');
class SecureAgent extends https.Agent {
  constructor(max){super({keepAlive:true,maxSockets:max,maxFreeSockets:32});this.idleTimeoutMs=4000;}
  keepSocketAlive(socket){return BenchmarkAgent.prototype.keepSocketAlive.call(this,socket);}
  reuseSocket(socket,req){return BenchmarkAgent.prototype.reuseSocket.call(this,socket,req);}
}
async function load({input,url,maxOutstanding=128,drainSec=300}) {
  const target=new URL(url),transport=transportObserver();
  const agent=target.protocol==='https:'?new SecureAgent(maxOutstanding):new BenchmarkAgent(maxOutstanding);
  const send=target.protocol==='https:'?https.request:http.request;
  const rows=[],pending=new Set(),wakeups=[];
  const start=performance.now()+100,epochStartMs=Date.now()+100;
  const payloads=input.requests.map(r=>Buffer.from(JSON.stringify(r)));
  await scheduleAbsolute({requests:input.requests,start,wakeups,dispatch(request,index){
    const row={requestId:request.requestId,scheduledMs:request.arrivalOffsetMs,dispatchMs:null,attempts:0};rows.push(row);
    if(pending.size>=maxOutstanding){row.capacityMiss=true;return;}
    row.dispatchMs=performance.now()-start;row.dispatchEpochMs=Date.now();row.attempts=1;
    const req=send(target,{method:'POST',agent,headers:{'content-type':'application/json','content-length':payloads[index].length}});
    pending.add(req);let settled=false;
    const timer=setTimeout(()=>req.destroy(new Error('client_deadline')),(input.durationSec+drainSec+10)*1000);
    const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);row.responseMs=performance.now()-start;pending.delete(req);};
    req.on('socket',socket=>{row.socketAssignedMs=performance.now()-start;row.reusedSocket=req.reusedSocket;row.socketId=transport.assign(socket,request.requestId);if(socket.connecting)socket.once('connect',()=>{row.connectedMs=performance.now()-start;});});
    req.on('error',error=>{row.transportError=error.message;row.transportErrorCode=error.code;finish();});
    req.on('response',res=>{
      row.httpStatus=res.statusCode;let body='';
      res.on('data',chunk=>{body+=chunk;if(body.length>1024*1024)res.destroy(new Error('response_too_large'));});
      res.on('end',()=>{try{row.outcome=JSON.parse(body);if(!Number.isInteger(row.outcome.status)||!['ALLOW','DOWNGRADE','DELAY','REJECT'].includes(row.outcome.decision))throw new Error('invalid_gateway_outcome');if(res.statusCode!==200&&row.outcome.reason!=='benchmark_handler_error')row.transportError=`HTTP_${res.statusCode}`;}catch(error){row.transportError=error.message;}finish();});
      res.on('aborted',()=>{row.transportError='response_aborted';finish();});res.on('error',error=>{row.transportError=error.message;finish();});
    });
    req.end(payloads[index]);row.submissionEndMs=performance.now()-start;
  }});
  const deadline=start+(input.durationSec+drainSec)*1000;
  while(performance.now()<start+input.durationSec*1000||(pending.size&&performance.now()<deadline))await new Promise(resolve=>setTimeout(resolve,10));
  const unresolvedAtCutoff=pending.size;
  for(const req of pending)req.destroy(new Error('drain_cutoff'));
  await new Promise(resolve=>setImmediate(resolve));agent.destroy();await new Promise(resolve=>setImmediate(resolve));
  return {rows,traceHash:input.hash,epochStartMs,elapsedMs:performance.now()-start,unresolvedAtCutoff,maxOutstanding,drainSec,
    scheduler:{absoluteStartUnchanged:true,wakeups},transport:{agent:agentConfig(agent),sockets:transport.sockets,events:transport.events},
    timingBoundary:'Client dispatch through complete HTTP response; scheduled arrival latency is recorded separately. No retries.'};
}
module.exports={load};
