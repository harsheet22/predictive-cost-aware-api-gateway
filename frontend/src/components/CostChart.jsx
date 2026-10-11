import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { MetricCard } from './MetricCard';
import { format } from '../telemetry';

/**
 * CostChart - time series of predicted vs actual cost, savings over time
 */
export function CostChart({ data, height = 280 }) {
  // data: [{ timestamp, baselineCost, predictiveCost, predictedCost, savings }, ...]
  if (!data || data.length === 0) {
    return <div className="chart-empty">No cost data available</div>;
  }

  return (
    <div className="chart-container">
      <p className="chart-subtitle">Sequential phases: baseline first, predictive second.</p>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 5, right: 10, left: 40, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#26364c" />
          <XAxis
            dataKey="timestamp"
            tick={{ fontSize: 10, fill: '#94a3b8' }}
            tickFormatter={(v) => new Date(v).toLocaleTimeString()}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#94a3b8' }}
            tickFormatter={(v) => `$${v.toFixed(6)}`}
            domain={[0, 'auto']}
          />
          <Tooltip
            formatter={(value, name) => {
              const labels = {
                baselineCost: 'Baseline Estimated Execution',
                predictiveCost: 'Predictive Estimated Execution',
                predictedCost: 'Predicted (ML)',
                savings: 'Savings %',
              };
              return [name === 'savings' ? `${value.toFixed(1)}%` : `$${value.toFixed(6)}`, labels[name] || name];
            }}
            contentStyle={{ background: '#111c2d', border: '1px solid #34465f', borderRadius: 8, color: '#edf3fc' }}
            labelFormatter={(v, payload) => `${new Date(v).toLocaleTimeString()} — ${payload?.[0]?.payload?.phase || ''} phase`}
          />
          <Legend />
          <Line type="monotone" dataKey="baselineCost" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} name="Baseline Estimated Execution" />
          <Line type="monotone" dataKey="predictiveCost" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} name="Predictive Estimated Execution" />
          <Line type="monotone" dataKey="predictedCost" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 5" dot={false} isAnimationActive={false} name="Predicted (ML)" />
        </LineChart>
      </ResponsiveContainer>

    </div>
  );
}

/**
 * CostSummaryCards - current cost snapshot
 */
export function CostSummaryCards({ baseline, predictive, report }) {
  const baselineCost = report.baselineCost;
  const predictiveCost = report.predictiveCost;
  const scale = Math.max(baselineCost, predictiveCost);
  return <div className="cost-comparison">
    <div className="cost-gateways">
      {[
        ['Baseline', baselineCost, report.baselinePerCompleted, baseline?.processed, 'baseline'],
        ['Predictive', predictiveCost, report.predictivePerCompleted, predictive?.processed, 'predictive'],
      ].map(([name, cost, perSuccess, completed, variant]) => <div className={`cost-gateway ${variant}`} key={name}>
        <span className="cost-label"><i className={`legend-dot ${variant}-dot`} />{name} estimated execution cost</span>
        <strong>${format(cost, 6)}</strong>
        <div className="cost-bar"><div style={{ width: `${scale ? cost / scale * 100 : 0}%` }} /></div>
        <span className="cost-per-success">${format(perSuccess, 9)} / completed request · {format(completed)} completed</span>
      </div>)}
    </div>
    <div className={`savings-banner ${report.difference < 0 ? 'negative' : ''}`}>
      <div><span>{report.label}</span><strong>{format(report.percent == null ? null : Math.abs(report.percent), 1)}%</strong></div>
      <p>Absolute estimated difference (baseline − predictive): ${format(report.difference, 9)}. Percentage denominator: baseline estimated execution cost.</p>
      <p>{report.fewerCompleted ? 'Predictive executed fewer requests; this reduction is not a like-for-like completion saving.' : report.comparable ? 'Same offered workload and completed-request count.' : 'Comparability is unverified; showing cost difference.'} Reduced-quality completions: {format(report.reduced)} (DOWNGRADE quality tradeoff).</p>
      <p>Illustrative model estimates, not AWS bills. ML serving and queue-holding costs are excluded.</p>
    </div>
  </div>;
}

export function PredictionAccuracyChart({ predictive }) {
  if (!predictive?.prediction?.samples) return <div className="chart-empty">{predictive?.prediction ? 'No online prediction samples in this experiment' : 'Online prediction telemetry unavailable'}</div>;
  const p = predictive.prediction;
  return <div className="online-error"><div><h3>Online Execution Prediction Error</h3><p>Execution-time estimates compared with measured Node execution wall time.</p></div><div className="accuracy-grid">
    <MetricCard label="MAE" value={format(p.maeMs, 1)} unit=" ms" />
    <MetricCard label="RMSE" value={format(p.rmseMs, 1)} unit=" ms" />
    <MetricCard label="Samples" value={p.samples} />
  </div></div>;
}
