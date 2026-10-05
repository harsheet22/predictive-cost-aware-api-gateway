import { useState, useEffect, useCallback } from 'react';
import { api } from './api/client';
import { useLiveMetrics, useComparison, useMLStatus } from './hooks/useMetrics';
import { MetricCard, MetricRow } from './components/MetricCard';
import { LatencyPercentileChart, ThroughputChart } from './components/ComparisonChart';
import { CostChart, CostSummaryCards, PredictionAccuracyChart } from './components/CostChart';
import { DecisionBreakdown, DecisionReasonTable } from './components/DecisionBreakdown';
import { RequestFeed, RequestSummary } from './components/RequestFeed';
import { SimulatorControls } from './components/SimulatorControls';
import { ThroughputSummary } from './components/ThroughputSummary';
import './App.css';

function App() {
  // State for comparison results
  const [comparison, setComparison] = useState(null);
  const [running, setRunning] = useState(false);
  const [requestFeed, setRequestFeed] = useState([]);

  // Live metrics (1 Hz polling)
  const { data: liveData, loading: liveLoading, error: liveError } = useLiveMetrics(1000);

  // ML status (5s polling)
  const { health: mlHealth, modelInfo: mlModelInfo } = useMLStatus(5000);

  // Comparison runner
  const runComparison = useCallback(async (config) => {
    setRunning(true);
    try {
      const result = await api.compareRun(config);
      setComparison(result);
      // Transform comparison result into request feed format
      const feed = [];
      // Note: the compare endpoint doesn't return individual requests by default
      // but we can generate some synthetic feed data for demo
      setRequestFeed(feed);
      return result;
    } finally {
      setRunning(false);
    }
  }, []);

  // Derived data from live metrics
  const baseline = liveData?.baseline || {};
  const predictive = liveData?.predictive || {};

  // Compute savings for display
  const savings = comparison?.savings || {
    absoluteUsd: (baseline.cost?.estimatedCloudCostUsd || 0) - (predictive.cost?.estimatedCloudCostUsd || 0),
    percent: baseline.cost?.estimatedCloudCostUsd
      ? ((baseline.cost.estimatedCloudCostUsd - predictive.cost.estimatedCloudCostUsd) / baseline.cost.estimatedCloudCostUsd * 100)
      : 0,
    slaMetDelta: (predictive.slaMet || 0) - (baseline.slaMet || 0),
    costPerSuccessDelta: (predictive.cost?.costPerSuccessUsd || 0) - (baseline.cost?.costPerSuccessUsd || 0),
  };

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Predictive Cost-Aware API Gateway</h1>
        <div className="header-status">
          <StatusIndicator label="Backend" active={!liveLoading && !liveError} />
          <StatusIndicator label="ML Service" active={mlHealth?.status === 'ok' && mlHealth?.modelLoaded} />
          <StatusIndicator label="ML Model" active={mlHealth?.modelLoaded} variant={mlHealth?.modelLoaded ? 'success' : 'warning'} />
        </div>
      </header>

      <main className="dashboard-main">
        {/* Top Row - Key Metrics */}
        <section className="metrics-row">
          <MetricCard label="Incoming" value={baseline.incoming || 0} delta={predictive.incoming ? ((predictive.incoming - baseline.incoming) / baseline.incoming * 100) : undefined} />
          <MetricCard label="Processed" value={predictive.processed || 0} delta={baseline.processed ? ((predictive.processed - baseline.processed) / baseline.processed * 100) : undefined} />
          <MetricCard label="Rejected" value={predictive.rejected || 0} />
          <MetricCard label="Delayed" value={predictive.delayed || 0} />
          <MetricCard label="Downgraded" value={predictive.downgraded || 0} />
          <MetricCard label="SLA Met" value={`${predictive.slaMet || 0}/${predictive.processed || 0}`} />
          <MetricCard label="Throughput (live)" value={predictive.rps || 0} unit=" req/s" delta={baseline.rps ? ((predictive.rps - baseline.rps) / baseline.rps * 100) : undefined} />
          <MetricCard label="Avg Latency" value={predictive.latency?.avg?.toFixed(1) || 0} unit=" ms" />
        </section>

        {/* Cost Summary */}
        <section className="card cost-summary">
          <h2>Cost Summary</h2>
          <CostSummaryCards baseline={baseline} predictive={predictive} savings={savings} />
        </section>

        {/* Experiment Throughput Summary */}
        {comparison?.throughput && (
          <ThroughputSummary throughput={comparison.throughput} />
        )}

        {/* Charts Grid */}
        <div className="charts-grid">
          {liveLoading ? (
            <>
              <section className="card"><div className="chart-empty">Loading metrics...</div></section>
              <section className="card"><div className="chart-empty">Loading metrics...</div></section>
              <section className="card"><div className="chart-empty">Loading metrics...</div></section>
            </>
          ) : (
            <>
              <section className="card">
                <LatencyPercentileChart baseline={baseline.latency} predictive={predictive.latency} />
              </section>
              <section className="card">
                <ThroughputChart baseline={baseline} predictive={predictive} />
              </section>
              <section className="card">
                <CostChart data={[]} />
                <PredictionAccuracyChart predictive={predictive} />
              </section>
            </>
          )}
        </div>

        {/* Decision Breakdown & Request Feed */}
        <div className="charts-grid">
          {!liveLoading ? (
            <>
              <section className="card wide">
                <DecisionBreakdown predictive={predictive} baseline={baseline} />
                <DecisionReasonTable predictive={predictive} />
              </section>
              <section className="card">
                <RequestSummary requests={requestFeed} />
                <RequestFeed requests={requestFeed} maxRows={15} />
              </section>
            </>
          ) : (
            <>
              <section className="card wide"><div className="chart-empty">Loading metrics...</div></section>
              <section className="card"><div className="chart-empty">Loading metrics...</div></section>
            </>
          )}
        </div>

        {/* Controls */}
        <section className="card controls-card">
          <SimulatorControls onRun={runComparison} running={running} lastResult={comparison} />
        </section>
      </main>

      <footer className="dashboard-footer">
        <p>Predictive Cost-Aware API Gateway — College Cloud Architecture Project</p>
        <p className="model-info">
          ML Model: {mlModelInfo?.modelVersion || 'heuristic-v1'} ({mlModelInfo?.modelType || 'heuristic'})
          {mlHealth?.modelLoaded ? ' ✓' : ' (fallback)'}
        </p>
      </footer>
    </div>
  );
}

function StatusIndicator({ label, active, variant = 'default' }) {
  const colors = {
    default: active ? '#10b981' : '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
  };
  return (
    <span className="status-indicator" style={{ '--status-color': colors[variant] }}>
      <span className="status-dot" style={{ backgroundColor: active ? colors[variant] : colors.default }} />
      {label}
    </span>
  );
}

export default App;