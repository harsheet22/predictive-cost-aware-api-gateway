import React from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

const COLORS = { ALLOW: '#10b981', DOWNGRADE: '#f59e0b', DELAY: '#3b82f6', REJECT: '#ef4444' };
export function DecisionBreakdown({ predictive }) {
  const decisions = [
    { name: 'ALLOW', value: predictive?.allowed || 0 },
    { name: 'DOWNGRADE', value: predictive?.downgraded || 0 },
    { name: 'DELAY', value: predictive?.delayed || 0 },
    { name: 'REJECT', value: predictive?.rejected || 0 },
  ];
  const total = decisions.reduce((sum, d) => sum + d.value, 0);
  return (
    <div className="decision-breakdown">
      <div className="decision-donut">
        {total > 0 ? <ResponsiveContainer width="100%" height={190}>
          <PieChart><Pie data={decisions.filter(d => d.value > 0)} cx="50%" cy="50%" innerRadius={62} outerRadius={82} paddingAngle={total && decisions.filter(d => d.value > 0).length > 1 ? 3 : 0} dataKey="value" nameKey="name" stroke="none" isAnimationActive={false}>
            {decisions.filter(d => d.value > 0).map(d => <Cell key={d.name} fill={COLORS[d.name]} />)}
          </Pie><Tooltip formatter={(value, name) => [value, name]} contentStyle={{ background: '#111c2d', border: '1px solid #34465f', borderRadius: 8, color: '#edf3fc' }} /></PieChart>
        </ResponsiveContainer> : <div className="empty-donut" />}
        <div className="donut-label"><strong>{total}</strong><span>decisions</span></div>
      </div>
      <div className="decision-counts">
        {decisions.map(d => <div className="decision-count" key={d.name}><span><i style={{ background: COLORS[d.name] }} />{d.name}</span><strong>{d.value}</strong><small>{total ? (d.value / total * 100).toFixed(1) : '0.0'}%</small></div>)}
      </div>
    </div>
  );
}

export function DecisionReasonTable({ predictive }) {
  const reasons = predictive?.decisionReasons || [];
  return <div className="reason-table"><h3>Recorded decision reasons</h3><div className="table-scroll"><table><thead><tr><th>Decision</th><th>Reason</th><th>Count</th></tr></thead><tbody>
    {reasons.map(({ decision, reason, count }) => <tr key={`${decision}:${reason}`}><td><span className={`decision-badge decision-${decision.toLowerCase()}`}>{decision}</span></td><td className="reason-code">{reason}</td><td>{count}</td></tr>)}
    {!reasons.length && <tr><td colSpan={3}>No recorded decision reasons yet</td></tr>}
  </tbody></table></div></div>;
}
