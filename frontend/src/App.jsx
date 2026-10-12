import { useState, useCallback } from 'react';
import { api } from './api/client';
import { useLiveMetrics, useMLStatus } from './hooks/useMetrics';
import { SimulatorControls } from './components/SimulatorControls';
import { ExperimentResults } from './components/ExperimentResults';
import { ExternalLoadPanel } from './components/ExternalLoadPanel';
import { format } from './telemetry';
import './App.css';

function App() {
  const [comparison, setComparison] = useState(null);
  const [running, setRunning] = useState(false);
  const [externalRunning, setExternalRunning] = useState(false);
  const [mode, setMode] = useState('internal');
  const { data: liveData, loading, error } = useLiveMetrics(1000);
  const { health: mlHealth, modelInfo } = useMLStatus(5000);
  const runComparison = useCallback(async config => {
    setComparison(null);
    setRunning(true);
    try {
      const result = await api.compareRun(config);
      setComparison(result);
      return result;
    } finally { setRunning(false); }
  }, []);
  const resetComparison = useCallback(() => setComparison(null), []);
  const receiveExternal = useCallback(result => { setComparison(result); if (result) setMode('external'); }, []);
  const externalActivity = useCallback(active => { setExternalRunning(active); if (active) setMode('external'); }, []);
  return <div className="dashboard">
    <header className="dashboard-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true">↗</span><div><span className="eyebrow">CLOUD / ML OBSERVABILITY</span><h1>Predictive Cost-Aware API Gateway</h1></div></div>
      <div className="header-status"><StatusIndicator label="Backend" active={!loading && !error} /><StatusIndicator label="ML Service" active={mlHealth?.status === 'ok' && mlHealth?.modelLoaded} /><StatusIndicator label="ML Model" active={mlHealth?.modelLoaded} /></div>
    </header>
    <main className="dashboard-main">
      <div className="page-heading"><div><span className="eyebrow">EXPERIMENT WORKSPACE</span><h2>Admission control, measured.</h2><p>Compare the same workload across baseline and predictive gateways.</p></div><span className={`run-status ${running || externalRunning ? 'running' : ''}`}>{externalRunning ? 'External traffic running' : running ? 'Experiment running' : comparison ? 'Experiment complete' : 'Ready to compare'}</span></div>
      <section className="card controls-card">
        <div className="control-actions experiment-modes" role="group" aria-label="Experiment source">
          <button className={`btn ${mode === 'internal' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('internal')} disabled={running || externalRunning}>Built-in replay</button>
          <button className={`btn ${mode === 'external' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('external')} disabled={running}>External load</button>
        </div>
        {mode === 'internal' && <SimulatorControls onRun={runComparison} onReset={resetComparison} running={running || externalRunning} lastResult={comparison} />}
        <div hidden={mode !== 'external'}><ExternalLoadPanel onResult={receiveExternal} onActive={externalActivity} blocked={running} /></div>
      </section>
      <ExperimentResults comparison={comparison} running={running || externalRunning} />
      <details className="card diagnostics">
        <summary>Live operational metrics — separate from completed experiment</summary>
        {error ? <p role="alert">Live metrics unavailable: {error}. These last-known operational values may be stale.</p> : null}
        <p className="section-note">Built-in gateway process state, polled every second. External workers have their own progress and completed snapshots; these counters do not represent their traffic.</p>
        <div className="last-run-facts"><span>Requests in flight <strong>{format(liveData?.predictive?.inFlight)}</strong></span><span>Live successful completion rate <strong>{format(liveData?.predictive?.completedRps, 1)} req/s</strong></span><span>Prediction queue <strong>{format(liveData?.predictive?.predictionGate?.queueDepth)}</strong></span></div>
        <p className="section-note">Completion rate uses successful responses in the last five seconds (or process uptime if shorter).</p>
      </details>
    </main>
    <footer className="dashboard-footer"><span>Predictive Cost-Aware API Gateway</span><span className="model-info">Live model status: {modelInfo?.modelVersion ?? 'Awaiting model info'} · {modelInfo?.modelType ?? '—'}</span></footer>
  </div>;
}
function StatusIndicator({ label, active }) {
  return <span className={`status-indicator ${active ? 'healthy' : 'unhealthy'}`}><span className="status-dot" />{label}<span className="sr-only">{active ? ': healthy' : ': unavailable'}</span></span>;
}
export default App;
