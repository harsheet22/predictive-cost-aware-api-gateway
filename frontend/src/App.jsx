import { useState, useCallback } from 'react';
import { api } from './api/client';
import { useLiveMetrics, useMLStatus } from './hooks/useMetrics';
import { SimulatorControls } from './components/SimulatorControls';
import { ExperimentResults } from './components/ExperimentResults';
import { format } from './telemetry';
import './App.css';

function App() {
  const [comparison, setComparison] = useState(null);
  const [running, setRunning] = useState(false);
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
  return <div className="dashboard">
    <header className="dashboard-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true">↗</span><div><span className="eyebrow">CLOUD / ML OBSERVABILITY</span><h1>Predictive Cost-Aware API Gateway</h1></div></div>
      <div className="header-status"><StatusIndicator label="Backend" active={!loading && !error} /><StatusIndicator label="ML Service" active={mlHealth?.status === 'ok' && mlHealth?.modelLoaded} /><StatusIndicator label="ML Model" active={mlHealth?.modelLoaded} /></div>
    </header>
    <main className="dashboard-main">
      <div className="page-heading"><div><span className="eyebrow">EXPERIMENT WORKSPACE</span><h2>Admission control, measured.</h2><p>Compare the same workload across baseline and predictive gateways.</p></div><span className={`run-status ${running ? 'running' : ''}`}>{running ? 'Experiment running' : comparison ? 'Experiment complete' : 'Ready to compare'}</span></div>
      <section className="card controls-card"><SimulatorControls onRun={runComparison} onReset={resetComparison} running={running} lastResult={comparison} /></section>
      <ExperimentResults comparison={comparison} running={running} />
      <details className="card diagnostics">
        <summary>Live operational metrics — separate from completed experiment</summary>
        {error ? <p role="alert">Live metrics unavailable: {error}. These last-known operational values may be stale.</p> : null}
        <p className="section-note">Current process state, polled every second. These values do not update the completed experiment cards.</p>
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
