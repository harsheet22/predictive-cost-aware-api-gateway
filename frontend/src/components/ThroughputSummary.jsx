import { format } from '../telemetry';
export function ThroughputSummary({ throughput }) {
  const { baseline, predictive } = throughput;
  return <div className="throughput-summary">
    <div className="throughput-values">{[['Baseline', baseline, 'baseline'], ['Predictive', predictive, 'predictive']].map(([name, rates, variant]) => <div key={name}><span><i className={`legend-dot ${variant}-dot`} />{name}</span><strong>{format(rates.completedPerSec, 1)} <small>req/s</small></strong><p className="section-note">Phase elapsed: {format(rates.elapsedSec, 3)} s</p></div>)}</div>
    <p className="section-note">Final completion / incoming: baseline {format(baseline.completionPercent, 1)}% · predictive {format(predictive.completionPercent, 1)}%.</p>
    <p className="section-note">Actual phase elapsed runs from gateway phase start through final response and drain. It includes workload replay and queue/budget waiting.</p>
  </div>;
}
