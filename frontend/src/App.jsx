import { useState, useCallback } from 'react';
import { api } from './api/client';
import { useLiveMetrics, useMLStatus } from './hooks/useMetrics';
import { MetricCard } from './components/MetricCard';
import { LatencyPercentileChart, ThroughputChart } from './components/ComparisonChart';
import { CostChart, CostSummaryCards, PredictionAccuracyChart } from './components/CostChart';
import { DecisionBreakdown, DecisionReasonTable } from './components/DecisionBreakdown';
import { SimulatorControls } from './components/SimulatorControls';
import { ThroughputSummary } from './components/ThroughputSummary';
import './App.css';

function App() {
  const [comparison, setComparison] = useState(null);
  const [running, setRunning] = useState(false);
  const { data: liveData, loading: liveLoading, error: liveError } = useLiveMetrics(1000);
  const { health: mlHealth, modelInfo: mlModelInfo } = useMLStatus(5000);
  const runComparison = useCallback(async (config) => {
    setRunning(true);
    setComparison(null);
    try {
      const result = await api.compareRun(config);
      setComparison(result);
      return result;
    } finally {
      setRunning(false);
    }
  }, []);

  const baseline = liveData?.baseline || {};
  const predictive = liveData?.predictive || {};
  const throughput = {
    baseline: baseline.experimentThroughput,
    predictive: predictive.experimentThroughput,
  };
  const costHistory = [
    ...(baseline.costHistory || []).map(sample => ({
      timestamp: sample.timestamp, phase: sample.phase,
      baselineCost: sample.actualCostUsd,
    })),
    ...(predictive.costHistory || []).map(sample => ({
      timestamp: sample.timestamp, phase: sample.phase,
      predictiveCost: sample.actualCostUsd, predictedCost: sample.predictedCostUsd,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp);
  if (baseline.experiment?.endedAt && predictive.experiment?.endedAt && costHistory.length) {
    const baselineCost = baseline.cost?.estimatedCloudCostUsd || 0;
    costHistory[costHistory.length - 1].savings = baselineCost
      ? (baselineCost - predictive.cost.estimatedCloudCostUsd) / baselineCost * 100 : 0;
  }
  const savings = comparison?.savings || {
    absoluteUsd: (baseline.cost?.estimatedCloudCostUsd || 0) - (predictive.cost?.estimatedCloudCostUsd || 0),
    percent: baseline.cost?.estimatedCloudCostUsd
      ? ((baseline.cost.estimatedCloudCostUsd - predictive.cost.estimatedCloudCostUsd) / baseline.cost.estimatedCloudCostUsd * 100)
      : 0,
    slaMetDelta: (predictive.slaMet || 0) - (baseline.slaMet || 0),
    costPerSuccessDelta: (predictive.cost?.costPerSuccessUsd || 0) - (baseline.cost?.costPerSuccessUsd || 0),
  };
  const completed = Boolean(baseline.experiment?.endedAt && predictive.experiment?.endedAt);
  const hasRequests = Boolean(baseline.incoming || predictive.incoming);
  const ml = predictive.ml || {};

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">↗</span>
          <div><span className="eyebrow">CLOUD / ML OBSERVABILITY</span><h1>Predictive Cost-Aware API Gateway</h1></div>
        </div>
        <div className="header-status">
          <StatusIndicator label="Backend" active={!liveLoading && !liveError} />
          <StatusIndicator label="ML Service" active={mlHealth?.status === 'ok' && mlHealth?.modelLoaded} />
          <StatusIndicator label="ML Model" active={mlHealth?.modelLoaded} />
        </div>
      </header>
      <main className="dashboard-main">
        <div className="page-heading"><div><span className="eyebrow">EXPERIMENT WORKSPACE</span><h2>Admission control, measured.</h2><p>Compare the same workload across baseline and predictive gateways.</p></div><span className={`run-status ${running ? 'running' : ''}`}>{running ? 'Experiment running' : completed ? 'Experiment complete' : 'Ready to compare'}</span></div>
        <section className="card controls-card"><SimulatorControls onRun={runComparison} running={running} lastResult={comparison} /></section>
        {liveError && <div className="control-error" role="alert">Metrics unavailable: {liveError}. Displaying the last available snapshot.</div>}
        {liveLoading && <p className="section-note" role="status">Loading gateway metrics…</p>}
        <section aria-label="Experiment Summary" className="summary-section">
          <div className="section-heading"><h2>Experiment Summary</h2><span>{completed ? `${baseline.experiment.durationSec}s configured workload` : 'Live experiment snapshot'}</span></div>
          <div className="metrics-row">
            <MetricCard label="Requests" value={baseline.incoming || 0} description={`${predictive.processed || 0} processed by predictive gateway`} />
            <MetricCard label="Throughput" value={completed ? throughput.predictive?.processedPerSec || 0 : '—'} unit={completed ? ' req/s' : ''} description="Based on configured experiment duration" />
            <MetricCard label="Cost Savings" value={completed ? savings.percent.toFixed(1) : '—'} unit={completed ? '%' : ''} className={completed && savings.percent < 0 ? 'savings-negative' : 'savings-card'} description={completed ? 'Compared with baseline estimated cost' : 'Available after both phases finish'} />
            <MetricCard label="Gateway SLA ≤250 ms" value={`${predictive.slaMet || 0} / ${predictive.processed || 0}`} description="Successful requests within gateway deadline" />
          </div>
        </section>
        <div className="comparison-grid">
          <section className="card cost-section"><SectionHeading number="01" title="Cost Comparison" note="Estimated cloud execution cost" /><CostSummaryCards baseline={baseline} predictive={predictive} savings={completed ? savings : null} /></section>
          <section className="card throughput-section">
            <SectionHeading number="02" title="Experiment Throughput" note="Requests / configured experiment duration" />
            <ThroughputSummary throughput={throughput} completed={completed} />
            {completed && <ThroughputChart baseline={throughput.baseline} predictive={throughput.predictive} showTitle={false} />}
            <div className="live-rate"><span><i className="status-dot" /> Live completion rate</span><strong>{predictive.rps || 0} <small>req/s</small></strong></div>
          </section>
        </div>
        <section className="card admission-section"><SectionHeading number="03" title="Predictive Admission Decisions" note="Final recorded outcomes · no inferred categories" /><div className="admission-grid"><DecisionBreakdown predictive={predictive} /><DecisionReasonTable predictive={predictive} /></div></section>
        <section className="performance-grid" aria-label="Performance">
          <div className="card"><SectionHeading number="04" title="Latency Percentiles" note="Baseline vs predictive · milliseconds" /><LatencyPercentileChart baseline={baseline.latency} predictive={predictive.latency} showTitle={false} /></div>
          <div className="card"><SectionHeading number="05" title="Gateway Performance" note="Predictive gateway response timing" />
            <div className="gateway-latency"><span>Gateway Latency</span><strong>{predictive.latency?.avg?.toFixed(1) || '0.0'} <small>ms</small></strong><p>Includes prediction queueing, ML HTTP time, execution and other gateway stages.</p></div>
            <div className="performance-stats"><MetricCard label="SLA target" value="250" unit=" ms" /><MetricCard label="SLA compliance" value={`${predictive.slaMet || 0} / ${predictive.processed || 0}`} /></div>
            <p className="section-note">Processed successfully: <strong>{predictive.processed || 0}</strong>. Successful completion is separate from SLA compliance.</p>
          </div>
        </section>
        <section className="card history-section"><SectionHeading number="06" title="Cost History" note="Real timestamped samples · sequential gateway phases" /><CostChart data={costHistory} height={240} /></section>
        <section className="card ml-section"><SectionHeading number="07" title="ML Prediction Performance" note="Online execution error, separate from offline model evaluation" /><PredictionAccuracyChart predictive={predictive} /></section>
        <details className="card diagnostics">
          <summary><span><span className="section-number">08</span> Advanced Diagnostics</span><span className="diagnostics-hint">Gateway &amp; ML internals <span className="chevron">⌄</span></span></summary>
          <p className="section-note">Average timing values overlap: HTTP includes FastAPI processing; FastAPI includes inference.</p>
          <div className="diagnostics-grid">
            {[
              ['Prediction queue wait', ml.avgQueueWaitMs, ' ms'],
              ['ML HTTP latency', ml.avgHttpMs, ' ms'],
              ['FastAPI processing', ml.avgFastapiMs, ' ms'],
              ['RandomForest inference', ml.avgInferenceMs, ' ms'],
              ['Total prediction latency', ml.avgLatencyMs, ' ms'],
              ['HTTP minus FastAPI', ml.avgNetworkResidualMs, ' ms'],
              ['FastAPI worker queue', ml.avgWorkerQueueMs, ' ms'],
              ['Prediction throughput', ml.predictionThroughputPerSec, ' req/s'],
            ].map(([label, value, unit]) => <MetricCard key={label} label={label} value={value == null ? '—' : value.toFixed(1)} unit={unit} />)}
            <MetricCard label="ML errors" value={ml.errorCount || 0} /><MetricCard label="ML fallbacks" value={ml.fallbackCount || 0} /><MetricCard label="Predictions" value={ml.predictionCount || 0} /><MetricCard label="Requests in flight" value={predictive.inFlight || 0} />
            <MetricCard label="Online R²" value={predictive.prediction?.r2?.toFixed(3) || '0'} /><MetricCard label="Online MAPE" value={((predictive.prediction?.mape || 0) * 100).toFixed(1)} unit="%" />
          </div>
          <p className="section-note">Rate limited: {predictive.rateLimited || 0} · Load shed: {predictive.shed || 0} · Gateway errors: {predictive.errors || 0}</p>
        </details>
        {!hasRequests && <p className="section-note empty-instruction">Choose a workload and run a comparison to populate this workspace.</p>}
      </main>
      <footer className="dashboard-footer"><span>Predictive Cost-Aware API Gateway</span><span className="model-info">Model: {mlModelInfo?.modelVersion || 'Awaiting model info'} · {mlModelInfo?.modelType || '—'}</span></footer>
    </div>
  );
}

function SectionHeading({ number, title, note }) {
  return <div className="section-heading"><div className="section-title"><span className="section-number">{number}</span><h2>{title}</h2></div><span>{note}</span></div>;
}
function StatusIndicator({ label, active }) {
  return <span className={`status-indicator ${active ? 'healthy' : 'unhealthy'}`}><span className="status-dot" />{label}<span className="sr-only">{active ? ': healthy' : ': unavailable'}</span></span>;
}
export default App;
