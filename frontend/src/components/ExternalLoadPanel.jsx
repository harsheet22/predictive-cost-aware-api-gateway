import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { format } from '../telemetry';

const externalActive = state => ['created', 'starting', 'running', 'finalizing', 'stopping', 'baseline-complete'].includes(state);
export function ExternalLoadPanel({ onResult, onActive, blocked = false }) {
  const [status, setStatus] = useState({ state: 'idle' });
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const handled = useRef(null); const completed = useRef(null); const commandBox = useRef(null);
  const origin = import.meta.env.DEV ? 'http://localhost:3000' : (typeof window === 'undefined' ? 'http://YOUR_EC2_PUBLIC_IP' : window.location.origin);
  const command = `node backend/benchmarks/external/run.cjs --url ${origin} --profile mixed --rates 10,25,50 --duration 5 --seed 42 --drain 300`;
  useEffect(() => {
    let active = true; let timer;
    async function poll() {
      try {
        const next = await api.externalLatest();
        const saved = await api.externalHistory();
        if (!active) return;
        setStatus(next); setHistory(saved); setError(null);
        onActive(externalActive(next.state) || next.cleanupBlocked);
        if (!blocked && next.id && handled.current !== next.id) {
          onResult(null); handled.current = next.id;
        }
        if (!blocked && next.state === 'complete' && next.comparison && completed.current !== next.id) {
          onResult(next.comparison); completed.current = next.id;
        }
      } catch (e) { if (active) setError(e.message); }
      finally { if (active) timer = setTimeout(poll, 1000); }
    }
    poll(); return () => { active = false; clearTimeout(timer); };
  }, [onResult, onActive, blocked]);
  async function select(id) {
    try { const report = await api.externalReport(id); if (report.comparison && report.state === 'complete') onResult(report.comparison); else setError(report.error || 'This run is incomplete or invalid; no paired comparison is available.'); }
    catch (e) { setError(e.message); }
  }
  async function download() {
    try {
      const report = await api.externalReport(status.id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `external-${status.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e.message); }
  }
  const active = externalActive(status.state);
  const percent = status.totalRequests ? Math.min(100, (status.received || 0) / status.totalRequests * 100) : 0;
  return <div className="external-load-panel">
    <div className="section-heading"><h3>External Load Demo</h3><span className={`run-status ${active ? 'running' : ''}`}>{status.state === 'idle' ? 'Waiting for laptop traffic' : status.state.replaceAll('-', ' ')}</span></div>
    <p className="section-note">Run the command in your laptop’s project terminal. The same saved requests are sent to fresh baseline and predictive workers in sequence. No automatic retries.</p>
    <textarea ref={commandBox} className="external-command" aria-label="External load command" readOnly value={command} onFocus={e => e.target.select()} rows={3} />
    <div className="control-actions">
      <button className="btn btn-secondary" onClick={async () => { try { if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(command); setNotice('Command copied.'); } catch { commandBox.current.focus(); commandBox.current.select(); setNotice('Command selected. Press Ctrl+C to copy.'); } }}>Copy laptop command</button>
      <button className="btn btn-secondary" disabled={!status.id} onClick={download}>Download current evidence</button>
    </div>
    {notice && <p className="section-note" role="status">{notice}</p>}
    {blocked && <p className="section-note">A built-in experiment is running. Wait for it to finish before launching the external command.</p>}
    {status.id && <>
      <div className="external-progress" role="progressbar" aria-label="External requests received this phase" aria-valuenow={status.received || 0} aria-valuemin={0} aria-valuemax={status.totalRequests}><span style={{ width: `${percent}%` }} /></div>
      <div className="last-run-facts"><span>Phase <strong>{status.arm || 'Preparing'}</strong></span><span>Configured load <strong>{format(status.rate)} req/s</strong></span><span>Received by proxy <strong>{format(status.received)} / {format(status.totalRequests)}</strong></span><span>Responses <strong>{format(status.completedResponses)}</strong></span><span>Pending <strong>{format(status.pending)}</strong></span></div>
    </>}
    {(error || status.error) && <div className="control-error" role="alert">{error || status.error}</div>}
    {Object.entries(status.summaries || {}).some(([,s]) => !s.valid) && <p className="section-note">Invalid run retained. The runner stops without launching the next arm or load level. Download its evidence to inspect failed validity checks.</p>}
    {history.length > 0 && <div className="external-history"><span>Saved runs</span>{history.map(run => <button className="btn btn-secondary" key={run.id} disabled={active || blocked || run.state !== 'complete'} onClick={() => select(run.id)}>{run.rate} req/s · {run.state}</button>)}</div>}
    <p className="section-note">This is a current-system demo: quality and reuse differ. ML stays on the deployed service; per-worker resource measurements exclude Python. CloudWatch provides whole-instance context.</p>
  </div>;
}
