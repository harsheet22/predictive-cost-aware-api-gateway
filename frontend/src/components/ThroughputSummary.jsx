import React from 'react';

export function ThroughputSummary({ throughput, completed = true }) {
  const { baseline, predictive } = throughput || {};
  return <div className="throughput-summary">
    <div className="throughput-values">
      <div><span><i className="legend-dot baseline-dot" />Baseline</span><strong>{completed ? baseline?.processedPerSec?.toFixed(1) || '0.0' : '—'} <small>req/s</small></strong></div>
      <div><span><i className="legend-dot predictive-dot" />Predictive</span><strong>{completed ? predictive?.processedPerSec?.toFixed(1) || '0.0' : '—'} <small>req/s</small></strong></div>
    </div>
    {!completed && <p className="section-note">Completed throughput is available when both phases finish.</p>}
    <details className="throughput-details"><summary>Per-gateway throughput breakdown</summary><div className="table-scroll"><table><thead><tr><th>req/s</th><th>Baseline</th><th>Predictive</th></tr></thead><tbody>
      {['incoming', 'processed', 'rejected', 'delayed', 'downgraded'].map(key => <tr key={key}><td>{key}</td><td>{completed ? baseline?.[`${key}PerSec`]?.toFixed(1) || '0.0' : '—'}</td><td>{completed ? predictive?.[`${key}PerSec`]?.toFixed(1) || '0.0' : '—'}</td></tr>)}
    </tbody></table></div></details>
  </div>;
}
