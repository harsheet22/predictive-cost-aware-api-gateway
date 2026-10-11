'use strict';
// Pure/injected helpers. Importing this module performs no Windows operations.
function safeSink(sink, fallback = value => { try { console.error(JSON.stringify(value)); } catch {} }) {
  let failed = false;
  const emit = value => {
    try { sink(value); return true; }
    catch (error) { failed = true; try { fallback({ kind: 'evidence_write_failed', error: error.message, original: value }); } catch {} return false; }
  };
  emit.failed = () => failed;
  return emit;
}
function measured(value) { return Number.isFinite(value) && value >= 0; }
function validateDisk(disk) {
  if (!disk || !measured(disk.freeBytes) || typeof disk.volume !== 'string' || !disk.volume || disk.localFixed !== true)
    throw new Error('Missing/invalid free-space measurement or unsupported output volume');
  return disk;
}
function validatePermissions(value) {
  if (!value || value.private !== true || !value.ownerSid || !Array.isArray(value.rules) || !value.rules.length)
    throw new Error('Private output-directory permissions could not be verified');
  return value;
}
function classifySessions(before, current, owned) {
  const expected = [...(owned.network ? [owned.network] : []), ...(owned.cpu?.sessions || [])];
  const same = (a, b) => ['name', 'handle', 'guid', 'file'].every(k => a[k] === b[k]);
  return current.filter(s => !before.some(old => same(old, s))).map(session => ({ session,
    ownership: expected.some(e => same(e, session)) ? 'identified' : 'unknown' }));
}
function launchState() {
  let ready = false, authorized = false, cancelled = false, stopped = false, failed = false;
  return {
    update(message) {
      if (message.kind === 'ready') ready = true;
      if (message.kind === 'launch_authorized') authorized = true;
      if (['stopping', 'stopped'].includes(message.kind)) stopped = true;
      if (['startup_failed', 'watchdog_failed'].includes(message.kind)) failed = true;
    },
    cancel() { cancelled = true; },
    isStopping() { return stopped; },
    canRequest(connected) { return connected && ready && !cancelled && !stopped && !failed; },
    canLaunch(connected) { return this.canRequest(connected) && authorized; },
  };
}
// The parent observes failure immediately, independently of awaiting benchmark exit.
function superviseWatchdog(child, state, onFailure, onLedger, event) {
  let settled = false, recovery = Promise.resolve(), outcome;
  const finish = result => {
    if (settled) return; settled = true; outcome = result;
    if (result.error || result.code !== 0) {
      state.update({ kind: 'watchdog_failed' });
      recovery = Promise.resolve().then(() => onFailure(result)).catch(error => event({ kind: 'recovery_failed', error: error.message }));
    } else state.update({ kind: 'stopped' });
  };
  child.on('message', message => { state.update(message); if (message.kind === 'ledger') onLedger(message.ledger); });
  child.once('disconnect', () => { if (!state.isStopping()) finish({ error: 'Watchdog IPC disconnected unexpectedly' }); });
  child.once('error', error => finish({ error: error.message }));
  child.once('exit', (code, signal) => finish({ code, signal }));
  return { recovery: () => recovery, outcome: () => outcome };
}
module.exports = { safeSink, measured, validateDisk, validatePermissions, classifySessions, launchState, superviseWatchdog };
