import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { MetricCard } from './MetricCard';

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
                baselineCost: 'Baseline Actual',
                predictiveCost: 'Predictive Actual',
                predictedCost: 'Predicted (ML)',
                savings: 'Savings %',
              };
              return [name === 'savings' ? `${value.toFixed(1)}%` : `$${value.toFixed(6)}`, labels[name] || name];
            }}
            contentStyle={{ background: '#111c2d', border: '1px solid #34465f', borderRadius: 8, color: '#edf3fc' }}
            labelFormatter={(v, payload) => `${new Date(v).toLocaleTimeString()} — ${payload?.[0]?.payload?.phase || ''} phase`}
          />
          <Legend />
          <Line type="monotone" dataKey="baselineCost" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} name="Baseline Actual" />
          <Line type="monotone" dataKey="predictiveCost" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} name="Predictive Actual" />
          <Line type="monotone" dataKey="predictedCost" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 5" dot={false} isAnimationActive={false} name="Predicted (ML)" />
        </LineChart>
      </ResponsiveContainer>

    </div>
  );
}

/**
 * CostSummaryCards - current cost snapshot
 */
export function CostSummaryCards({ baseline, predictive, savings }) {
  const baselineCost = baseline?.cost?.estimatedCloudCostUsd || 0;
  const predictiveCost = predictive?.cost?.estimatedCloudCostUsd || 0;
  const scale = Math.max(baselineCost, predictiveCost);
  return <div className="cost-comparison">
    <div className="cost-gateways">
      {[
        ['Baseline', baselineCost, baseline?.cost?.costPerSuccessUsd, 'baseline'],
        ['Predictive', predictiveCost, predictive?.cost?.costPerSuccessUsd, 'predictive'],
      ].map(([name, cost, perSuccess, variant]) => <div className={`cost-gateway ${variant}`} key={name}>
        <span className="cost-label"><i className={`legend-dot ${variant}-dot`} />{name} Cost</span>
        <strong>${cost.toFixed(6)}</strong>
        <div className="cost-bar"><div style={{ width: `${scale ? cost / scale * 100 : 0}%` }} /></div>
        <span className="cost-per-success">${perSuccess?.toFixed(9) || '0.000000000'} / success</span>
      </div>)}
    </div>
    <div className={`savings-banner ${savings?.percent < 0 ? 'negative' : ''}`}>
      <div><span>Cost savings</span><strong>{savings ? `${savings.percent.toFixed(1)}%` : '—'}</strong></div>
      <p>{savings ? `${savings.absoluteUsd < 0 ? 'Additional cost' : 'Estimated reduction'}: $${Math.abs(savings.absoluteUsd).toFixed(6)}` : 'Comparison available after both gateway phases complete.'}</p>
    </div>
  </div>;
}

export function PredictionAccuracyChart({ predictive }) {
  if (!predictive?.prediction?.samples) return <div className="chart-empty">No online prediction samples yet</div>;
  const p = predictive.prediction;
  return <div className="online-error"><div><h3>Online Execution Prediction Error</h3><p>Execution-time estimates compared with measured Node execution wall time.</p></div><div className="accuracy-grid">
    <MetricCard label="MAE" value={p.maeMs?.toFixed(1) || '0'} unit=" ms" />
    <MetricCard label="RMSE" value={p.rmseMs?.toFixed(1) || '0'} unit=" ms" />
    <MetricCard label="Samples" value={p.samples} />
  </div></div>;
}
