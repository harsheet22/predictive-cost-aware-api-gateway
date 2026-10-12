import { LatencyPercentileChart } from './ComparisonChart';
import { format } from '../telemetry';
export function ExternalEvidence({ run }) {
  if (!run?.external) return null;
  const e = run.external;
  const arms = [['Baseline', e.baseline], ['Predictive', e.predictive]];
  const chart = s => ({ ...s?.latency?.clientSuccessMs, avg: s?.latency?.clientSuccessMs?.mean });
  return <section className="card" aria-label="External request evidence">
    <div className="section-heading"><h2>External Request Evidence</h2><span>Matched trace · sequential fresh gateway workers</span></div>
    <p className="section-note">Configured load: {format(e.configuredRate)} req/s. Successful HTTP response latency includes your network, Nginx and the experiment proxy; gateway latency is shown separately below.</p>
    <div className="performance-grid"><LatencyPercentileChart baseline={chart(e.baseline)} predictive={chart(e.predictive)} showTitle={false} height={180} /><div>
      {arms.map(([name, s]) => <div className="external-arm" key={name}><h3>{name} · {s?.valid ? 'Validity checks passed' : 'Invalid'}</h3><div className="last-run-facts">
        <span>Offered / dispatched <strong>{format(s?.counts?.offered)} / {format(s?.counts?.dispatched)}</strong></span>
        <span>Completed / rejected / failed <strong>{format(s?.counts?.completed)} / {format(s?.counts?.rejected)} / {format(s?.counts?.failed)}</strong></span>
        <span>Transport errors <strong>{format(s?.counts?.transportErrors)}</strong></span>
        <span>Client completion rate <strong>{format(s?.throughput?.completedIncludingDrainPerSec, 1)} req/s</strong></span>
        <span>Client SLA / offered <strong>{format(s?.sla?.clientMet)} / {format(s?.sla?.offeredDenominator)}</strong></span>
        <span>Dispatch lateness p99 <strong>{format(s?.dispatchLatenessMs?.p99, 2)} ms</strong></span>
      </div></div>)}
    </div></div>
    <details className="diagnostics"><summary>External validation and resources</summary>
      <p className="section-note">Original timing gates: p99 dispatch lateness ≤20 ms and at least 99% dispatched by horizon +20 ms. Gateways see identical request contents; client observations are reported by the laptop runner.</p>
      {arms.map(([name,s]) => <div key={name}><h3>{name}</h3><p className="section-note">{Object.entries(s?.checks || {}).map(([key,ok]) => `${key}: ${ok ? 'pass' : 'FAIL'}`).join(' · ')}</p><p className="section-note">Gateway worker CPU: {format(s?.resources?.node?.cpuSeconds, 3)} seconds · sampled peak RSS: {format(s?.resources?.node?.peakRssBytes / 1048576, 1)} MiB. Excludes parent proxy and Python.</p></div>)}
      <p className="section-note">Trace SHA-256: {e.traceHash}</p>
      {(e.limitations || []).map(note => <p className="section-note" key={note}>{note}</p>)}
    </details>
  </section>;
}
