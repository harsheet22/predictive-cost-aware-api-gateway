import React from 'react';

/**
 * RequestFeed - live table of recent requests with decisions
 */
export function RequestFeed({ requests, maxRows = 20 }) {
  if (!requests || requests.length === 0) {
    return <div className="feed-empty">No requests yet</div>;
  }

  const displayRequests = requests.slice(0, maxRows);

  return (
    <div className="request-feed">
      <h3 className="chart-title">Recent Requests</h3>
      <div className="feed-table-wrapper">
        <table className="feed-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Priority</th>
              <th>Decision</th>
              <th>Reason</th>
              <th>Latency</th>
              <th>Cost</th>
              <th>SLA</th>
            </tr>
          </thead>
          <tbody>
            {displayRequests.map((req, i) => (
              <tr key={i} className={`feed-row decision-${req.decision?.toLowerCase() || 'unknown'}`}>
                <td>{new Date(req.timestamp || req.arrivalTs).toLocaleTimeString()}</td>
                <td><span className="type-badge">{req.type}</span></td>
                <td>{req.priority}</td>
                <td>
                  <span className={`decision-badge decision-${req.decision?.toLowerCase() || 'unknown'}`}>
                    {req.decision || '—'}
                  </span>
                </td>
                <td>{req.reason || '—'}</td>
                <td>{req.latencyMs?.toFixed(1) || '—'} ms</td>
                <td>${req.actualCloudCostUsd?.toFixed(6) || '0.000000'}</td>
                <td>
                  <span className={`sla-badge ${req.slaMet ? 'met' : 'missed'}`}>
                    {req.slaMet ? '✓' : '✗'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * RequestSummary - quick stats about the feed
 */
export function RequestSummary({ requests }) {
  if (!requests || requests.length === 0) return null;

  const total = requests.length;
  const slaMet = requests.filter((r) => r.slaMet).length;
  const avgLatency = requests.reduce((sum, r) => sum + (r.latencyMs || 0), 0) / total;
  const totalCost = requests.reduce((sum, r) => sum + (r.actualCloudCostUsd || 0), 0);

  return (
    <div className="feed-summary">
      <MetricCard label="Total" value={total} />
      <MetricCard label="SLA Met" value={`${((slaMet / total) * 100).toFixed(1)}%`} />
      <MetricCard label="Avg Latency" value={avgLatency.toFixed(1)} unit=" ms" />
      <MetricCard label="Total Cost" value={totalCost.toFixed(6)} unit=" USD" />
    </div>
  );
}

function MetricCard({ label, value }) {
  return (
    <div className="mini-metric-card">
      <div className="mini-metric-label">{label}</div>
      <div className="mini-metric-value">{value}</div>
    </div>
  );
}