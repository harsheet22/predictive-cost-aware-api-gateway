import { MetricCard } from './MetricCard';
import { LatencyPercentileChart } from './ComparisonChart';
import { CostChart, CostSummaryCards, PredictionAccuracyChart } from './CostChart';
import { DecisionBreakdown } from './DecisionBreakdown';
import { ThroughputSummary } from './ThroughputSummary';
import { ExternalEvidence } from './ExternalEvidence';
import { selectExperiment, phaseRates, costComparison, costSamples, gateReason, reconciliationIssues, format } from '../telemetry';

export function ExperimentResults({ comparison, running = false }) {
  const run = selectExperiment(comparison, running);
  if (!run) return <p className="section-note empty-instruction">{running ? 'Running comparison… Previous experiment results have been cleared.' : 'Run a comparison to display a completed experiment. Missing telemetry is shown as —.'}</p>;
  const b = run.baseline; const p = run.predictive;
  const g = p?.predictionGate; const ml = p?.ml; const de = p?.decisionEngine;
  const throughput = { baseline: phaseRates(b, run.durationSec), predictive: phaseRates(p, run.durationSec) };
  const costs = costComparison(run); const issues = reconciliationIssues(run);
  const countPair = (a, total) => `${format(a)} / ${format(total)}`;
  return <>
    <section className="summary-section" aria-label="Experiment Summary">
      <div className="section-heading"><h2>Experiment Summary</h2><span>{run.profile} · seed {run.seed} · {format(run.durationSec)}s configured workload</span></div>
      <p className="section-note">{run.source === 'external' ? 'External comparison' : 'Completed experiment'} {run.runId ?? 'ID unavailable'} — every result below uses this response snapshot.</p>
      {issues.length ? <div className="control-error" role="alert">Telemetry discrepancies: {issues.join(' ')}</div> : null}
      <div className="metrics-row">
        <MetricCard label="Total incoming requests" value={format(p?.incoming)} description={`Baseline: ${format(b?.incoming)} · generated workload: ${format(run.totalRequests)}`} />
        <MetricCard label="Incoming request rate" value={format(throughput.predictive.incomingPerSec, 1)} unit=" req/s" description={`Incoming / ${format(run.durationSec)}s configured duration`} />
        <MetricCard label="Successfully completed" value={format(p?.processed)} description={`Baseline: ${format(b?.processed)} · final rejected: ${format(p?.rejected)}`} />
        <MetricCard label={`Gateway SLA ≤${format(run.slaTargetMs)} ms`} value={countPair(p?.slaMet, p?.processed)} description="Denominator: predictive requests completed successfully" />
      </div>
    </section>
    <ExternalEvidence run={run} />
    <div className="comparison-grid">
      <section className="card cost-section"><SectionHeading number="01" title="Cost Comparison" note="Illustrative execution estimates · no AWS billing integration" /><CostSummaryCards baseline={b} predictive={p} report={costs} /></section>
      <section className="card throughput-section"><SectionHeading number="02" title="Experiment Throughput" note="Successful completions / actual phase elapsed time" /><ThroughputSummary throughput={throughput} /></section>
    </div>
    <section className="card admission-section"><SectionHeading number="03" title="Decision Breakdown" note="DecisionEngine Outcomes · first policy result, excluding reevaluations" />
      <div className="admission-grid">
        <DecisionBreakdown decisions={de?.outcomes} total={de?.reached} />
        <div className="reason-table">
          <h3>Prediction Admission Gate</h3>
          <p className="section-note">Admitted: {format(g?.admissions)} · immediate rejections: {format(g?.immediateRejections)} · expired: {format(g?.expirations)} · queue full: {format(gateReason(g, 'prediction_queue_full'))}.</p>
          <p className="section-note">Admission rate: {format(throughput.predictive.gateAdmittedPerSec, 1)} /s over the predictive phase. Gate rejection is separate from cost-policy rejection.</p>
          <p className="section-note">Policy percentages use only requests reaching DecisionEngine. An initial policy REJECT may later wait for budget and complete; final outcomes and reasons are in Advanced Diagnostics.</p>
        </div>
      </div>
    </section>
    <section className="card" aria-label="Gateway Performance"><SectionHeading number="04" title="Gateway Performance" note="Exact gateway latency · all terminal responses, including rejected" />
      <div className="performance-grid">
        <LatencyPercentileChart baseline={b?.latency?.exact} predictive={p?.latency?.exact} showTitle={false} height={180} />
        <div>
          <p className="section-note">Latency (ms), baseline / predictive:</p>
          <div className="last-run-facts">{['avg', 'p50', 'p95', 'p99'].map(key => <span key={key}>{key === 'avg' ? 'Mean' : key}<strong>{format(b?.latency?.exact?.[key], 3)} / {format(p?.latency?.exact?.[key], 3)}</strong></span>)}</div>
          <p className="section-note">Includes prediction, budget/execution waiting and execution. Percentiles use exact nearest-rank samples.</p>
          <div className="last-run-facts"><span>Execution failures <strong>{format(p?.execution?.failures)}</strong></span><span>Cached completions <strong>{format(p?.execution?.cachedCompleted)}</strong></span></div>
        </div>
      </div>
    </section>
    <section className="card history-section"><SectionHeading number="05" title="Cost History" note="Timestamped estimated costs · this run's sequential phases" /><CostChart data={costSamples(run)} height={200} /></section>
    <section className="card ml-section"><SectionHeading number="06" title="ML Prediction Performance" note="Completed attempts include failures and fallbacks" />
      <p className="section-note">Started: {format(ml?.startedCount)} · completed attempts: {format(ml?.completedCount)} · successful model predictions: {format(ml?.successCount)} · ML failures: {format(ml?.failureCount)} · fallbacks: {format(ml?.fallbackCount)}.</p>
      <PredictionAccuracyChart predictive={p} />
    </section>
    <details className="card diagnostics"><summary>Advanced Diagnostics</summary>
      <p className="section-note">Completed-run details. HTTP includes FastAPI; FastAPI includes inference. These timing averages are not independent additive stages.</p>
      <div className="last-run-facts">{[
        ['Prediction queue wait', ml?.avgQueueWaitMs], ['ML HTTP latency', ml?.avgHttpMs], ['FastAPI processing', ml?.avgFastapiMs],
        ['RandomForest inference', ml?.avgInferenceMs], ['Total prediction latency', ml?.avgLatencyMs], ['HTTP minus FastAPI', ml?.avgNetworkResidualMs],
      ].map(([label, value]) => <span key={label}>{label}<strong>{ml?.completedCount > 0 ? format(value, 1) : '—'} ms</strong></span>)}</div>
      <p className="section-note">Gate submissions: {format(g?.submissions)} · total gate rejections (including expiry): {format(g?.rejections)} · peak waiting depth: {format(g?.queuePeak)}.</p>
      <p className="section-note">Gate rejection reasons: {g?.rejectionReasons ? Object.entries(g.rejectionReasons).map(([reason, count]) => `${reason}: ${format(count)}`).join(' · ') || 'None recorded' : '—'}.</p>
      <p className="section-note">Initial policy reasons: {de?.reasons ? de.reasons.map(({ decision, reason, count }) => `${decision} / ${reason}: ${format(count)}`).join(' · ') || 'None recorded' : '—'}.</p>
      <p className="section-note">Final gateway classifications: ALLOW {format(p?.allowed)} · DOWNGRADE {format(p?.downgraded)} · DELAY {format(p?.delayed)} · REJECT {format(p?.rejected)} (includes early rejections and failures).</p>
      <p className="section-note">In flight: {format(p?.inFlight)} · rate-limiter rejected before gate: {format(p?.pipeline?.prePredictionRateRejections)} · rejected after cost policy: {format(p?.pipeline?.postDecisionRejected)} · full-quality completions: {format(p?.execution?.fullQualityCompleted)}.</p>
    </details>
  </>;
}
function SectionHeading({ number, title, note }) {
  return <div className="section-heading"><div className="section-title"><span className="section-number">{number}</span><h2>{title}</h2></div><span>{note}</span></div>;
}
