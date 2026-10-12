'use strict';
const { fork } = require('child_process');
const path = require('path');
function message(child, kind, value, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const finish = (error, data) => { clearTimeout(timer); child.off('message', receive); child.off('exit', exited); child.off('error', failed); error ? reject(error) : resolve(data); };
    const receive = data => { if (data.kind === kind) finish(null, data); };
    const exited = (code, signal) => finish(new Error(`Gateway worker exited: ${code}/${signal}`));
    const failed = error => finish(error);
    const timer = setTimeout(() => finish(new Error(`Gateway worker ${kind} timeout`)), timeoutMs);
    child.on('message', receive); child.once('exit', exited); child.once('error', failed);
    if (value) child.send(value, error => { if (error) finish(error); });
  });
}
async function startWorker(arm, input, runId) {
  if (!['baseline', 'predictive'].includes(arm)) throw new Error('External demo only supports baseline and predictive');
  const logs = [];
  const child = fork(path.resolve(__dirname, 'worker-server.cjs'), [arm], {
    cwd: path.resolve(__dirname, '../../..'), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, silent: true, windowsHide: true, serialization: 'advanced',
  });
  child.on('error', error => logs.push(`worker error: ${error.message}`));
  child.stdout.on('data', data => logs.push(data.toString())); child.stderr.on('data', data => logs.push(data.toString()));
  async function stop() {
    if (child.exitCode != null || child.signalCode != null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.connected) child.send({ kind: 'stop' }, () => {});
    const wait = async ms => { let timer; try { await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,ms);})]); } finally { clearTimeout(timer); } };
    await wait(1500);
    if (child.exitCode == null && child.signalCode == null) child.kill();
    await wait(1500);
    if (child.exitCode == null && child.signalCode == null) throw new Error('Owned gateway worker did not exit; cleanup is unverified');
  }
  try {
    const ready = await message(child, 'ready');
    await message(child, 'begun', { kind: 'begin', runId, traceHash: input.hash, durationSec: input.durationSec });
    return { ready, logs, stop, alive: () => child.exitCode == null && child.signalCode == null,
      execute: async request => {
        const response = await fetch(`http://127.0.0.1:${ready.port}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout((input.durationSec + 330) * 1000) });
        return { httpStatus: response.status, outcome: await response.json() };
      },
      snapshot: async () => (await message(child, 'snapshot', { kind: 'snapshot' })).data,
    };
  } catch (error) { await stop(); throw error; }
}
module.exports = { startWorker };
