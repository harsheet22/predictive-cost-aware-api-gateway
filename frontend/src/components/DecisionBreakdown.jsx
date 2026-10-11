import React from 'react';
import { format, number } from '../telemetry';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

const COLORS = { ALLOW: '#10b981', DOWNGRADE: '#f59e0b', DELAY: '#3b82f6', REJECT: '#ef4444' };
export function DecisionBreakdown({ decisions: counts, total }) {
  const decisions = [
    { name: 'ALLOW', value: number(counts?.ALLOW) },
    { name: 'DOWNGRADE', value: number(counts?.DOWNGRADE) },
    { name: 'DELAY', value: number(counts?.DELAY) },
    { name: 'REJECT', value: number(counts?.REJECT) },
  ];
  return (
    <div className="decision-breakdown">
      <div className="decision-donut">
        {total > 0 ? <ResponsiveContainer width="100%" height={190}>
          <PieChart><Pie data={decisions.filter(d => d.value > 0)} cx="50%" cy="50%" innerRadius={62} outerRadius={82} paddingAngle={total && decisions.filter(d => d.value > 0).length > 1 ? 3 : 0} dataKey="value" nameKey="name" stroke="none" isAnimationActive={false}>
            {decisions.filter(d => d.value > 0).map(d => <Cell key={d.name} fill={COLORS[d.name]} />)}
          </Pie><Tooltip formatter={(value, name) => [value, name]} contentStyle={{ background: '#111c2d', border: '1px solid #34465f', borderRadius: 8, color: '#edf3fc' }} /></PieChart>
        </ResponsiveContainer> : <div className="empty-donut" />}
        <div className="donut-label"><strong>{format(total)}</strong><span>policy requests</span></div>
      </div>
      <div className="decision-counts">
        {decisions.map(d => <div className="decision-count" key={d.name}><span><i style={{ background: COLORS[d.name] }} />{d.name}</span><strong>{format(d.value)}</strong><small>{total > 0 && d.value != null ? (d.value / total * 100).toFixed(1) : '—'}%</small></div>)}
      </div>
    </div>
  );
}

export function DecisionReasonTable({ reasons }) {
  return <div className="reason-table"><h3>Recorded decision reasons</h3><div className="table-scroll"><table><thead><tr><th>Decision</th><th>Reason</th><th>Count</th></tr></thead><tbody>
    {reasons?.map(({ decision, reason, count }) => <tr key={`${decision}:${reason}`}><td><span className={`decision-badge decision-${decision.toLowerCase()}`}>{decision}</span></td><td className="reason-code">{reason}</td><td>{count}</td></tr>)}
    {!reasons?.length && <tr><td colSpan={3}>{reasons ? 'No cost-policy outcomes in this run' : 'Cost-policy reason telemetry unavailable'}</td></tr>}
  </tbody></table></div></div>;
}
