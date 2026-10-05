import React from 'react';
import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid
} from 'recharts';

const DECISION_COLORS = {
  ALLOW: '#10b981',
  DOWNGRADE: '#f59e0b',
  DELAY: '#3b82f6',
  REJECT: '#ef4444',
};

const DECISION_LABELS = {
  ALLOW: 'Allowed',
  DOWNGRADE: 'Downgraded',
  DELAY: 'Delayed',
  REJECT: 'Rejected',
};

/**
 * DecisionBreakdown - pie chart + bar chart of decisions with reasons
 */
export function DecisionBreakdown({ predictive, baseline }) {
  if (!predictive) return <div className="chart-empty">No data</div>;

  const decisions = [
    { name: 'ALLOW', value: predictive.allowed || 0 },
    { name: 'DOWNGRADE', value: predictive.downgraded || 0 },
    { name: 'DELAY', value: predictive.delayed || 0 },
    { name: 'REJECT', value: predictive.rejected || 0 },
  ].filter((d) => d.value > 0);

  const total = decisions.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className="decision-breakdown">
      <h3 className="chart-title">Decision Breakdown (Predictive Gateway)</h3>

      <div className="decision-grid">
        {/* Pie Chart */}
        <div className="decision-pie">
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={decisions}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                fill="#8884d8"
                paddingAngle={2}
                dataKey="value"
                nameKey="name"
                label={({ name, percent }) => `${DECISION_LABELS[name]} ${(percent * 100).toFixed(0)}%`}
                labelLine={false}
              >
                {decisions.map((d, i) => (
                  <Cell key={`cell-${d.name}`} fill={DECISION_COLORS[d.name]} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => [value, DECISION_LABELS[value] || '']} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Reasons Bar Chart */}
        <div className="decision-reasons">
          <h4>Rejection/Delay Reasons</h4>
          {predictive.rateLimited > 0 || predictive.shed > 0 || predictive.errors > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={[
                { name: 'Rate Limited', value: predictive.rateLimited || 0 },
                { name: 'Load Shed', value: predictive.shed || 0 },
                { name: 'Errors', value: predictive.errors || 0 },
              ].filter((d) => d.value > 0)}
                layout="vertical"
                margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="value" fill="#ef4444" radius={[0, 4, 4, 0]} maxBarSize={30} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="no-reasons">No rejections/delays</p>
          )}
        </div>
      </div>

      {/* Summary Stats */}
      <div className="decision-summary">
        <MetricCard label="Total Decisions" value={total} />
        <MetricCard label="Allow Rate" value={total ? `${((predictive.allowed || 0) / total * 100).toFixed(1)}%` : '0%'} />
        <MetricCard label="Downgrade Rate" value={total ? `${((predictive.downgraded || 0) / total * 100).toFixed(1)}%` : '0%'} />
        <MetricCard label="Reject Rate" value={total ? `${((predictive.rejected || 0) / total * 100).toFixed(1)}%` : '0%'} />
      </div>
    </div>
  );
}

/**
 * DecisionReasonTable - detailed table of reasons
 */
export function DecisionReasonTable({ predictive }) {
  if (!predictive) return null;

  // Aggregate reasons from the comparison result if available
  // For now show static breakdown
  return (
    <div className="reason-table">
      <h4>Decision Reasons</h4>
      <table>
        <thead>
          <tr>
            <th>Decision</th>
            <th>Reason</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          <tr><td className="decision-allow">ALLOW</td><td>cheap_and_budget_ok</td><td>{predictive.allowed || 0}</td></tr>
          <tr><td className="decision-allow">ALLOW</td><td>high_priority_budget_ok</td><td>—</td></tr>
          <tr><td className="decision-downgrade">DOWNGRADE</td><td>expensive_downgraded</td><td>{predictive.downgraded || 0}</td></tr>
          <tr><td className="decision-downgrade">DOWNGRADE</td><td>downgraded_cached</td><td>—</td></tr>
          <tr><td className="decision-delay">DELAY</td><td>expensive_under_pressure</td><td>{predictive.delayed || 0}</td></tr>
          <tr><td className="decision-delay">DELAY</td><td>cheap_concurrency_full</td><td>—</td></tr>
          <tr><td className="decision-reject">REJECT</td><td>budget_exceeded</td><td>—</td></tr>
          <tr><td className="decision-reject">REJECT</td><td>cpu_hard_limit</td><td>—</td></tr>
          <tr><td className="decision-reject">REJECT</td><td>queue_full</td><td>—</td></tr>
          <tr><td className="decision-reject">REJECT</td><td>concurrency_full</td><td>—</td></tr>
          <tr><td className="decision-reject">REJECT</td><td>rate_limited</td><td>{predictive.rateLimited || 0}</td></tr>
        </tbody>
      </table>
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