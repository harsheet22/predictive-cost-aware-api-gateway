import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, Area
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
      <h3 className="chart-title">Cloud Cost Over Time</h3>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 5, right: 10, left: 40, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis
            dataKey="timestamp"
            tick={{ fontSize: 10 }}
            tickFormatter={(v) => new Date(v).toLocaleTimeString()}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10 }}
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
            labelFormatter={(v) => new Date(v).toLocaleTimeString()}
          />
          <Legend />
          <Line type="monotone" dataKey="baselineCost" stroke="#ef4444" strokeWidth={2} dot={false} name="Baseline Actual" />
          <Line type="monotone" dataKey="predictiveCost" stroke="#10b981" strokeWidth={2} dot={false} name="Predictive Actual" />
          <Line type="monotone" dataKey="predictedCost" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 5" dot={false} name="Predicted (ML)" />
        </LineChart>
      </ResponsiveContainer>

      {/* Savings area chart */}
      <div className="chart-subtitle">Cost Savings %</div>
      <ResponsiveContainer width="100%" height={120}>
        <AreaChart data={data} margin={{ top: 5, right: 10, left: 40, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis dataKey="timestamp" tick={{ fontSize: 10 }} tickFormatter={(v) => new Date(v).toLocaleTimeString()} />
          <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v.toFixed(1)}%`} />
          <Tooltip formatter={(value) => [`${value.toFixed(1)}%`, 'Savings']} />
          <Area type="monotone" dataKey="savings" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.2} name="Savings %" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * CostSummaryCards - current cost snapshot
 */
export function CostSummaryCards({ baseline, predictive, savings }) {
  return (
    <div className="cost-summary-grid">
      <MetricCard
        label="Baseline Cost"
        value={baseline?.cost?.estimatedCloudCostUsd?.toFixed(6) || '0.000000'}
        unit=" USD"
      />
      <MetricCard
        label="Predictive Cost"
        value={predictive?.cost?.estimatedCloudCostUsd?.toFixed(6) || '0.000000'}
        unit=" USD"
        delta={savings?.percent}
      />
      <MetricCard
        label="Cost / Success (Baseline)"
        value={baseline?.cost?.costPerSuccessUsd?.toFixed(9) || '0.000000000'}
        unit=" USD"
      />
      <MetricCard
        label="Cost / Success (Predictive)"
        value={predictive?.cost?.costPerSuccessUsd?.toFixed(9) || '0.000000000'}
        unit=" USD"
        delta={savings?.costPerSuccessDelta ? (savings.costPerSuccessDelta / (baseline?.cost?.costPerSuccessUsd || 1) * 100) : undefined}
      />
    </div>
  );
}

/**
 * PredictionAccuracyChart - MAE, RMSE, R² over time
 */
export function PredictionAccuracyChart({ predictive }) {
  if (!predictive?.prediction?.samples) {
    return <div className="chart-empty">No prediction data yet</div>;
  }

  const p = predictive.prediction;
  return (
    <div className="chart-container">
      <h3 className="chart-title">Prediction Accuracy</h3>
      <div className="accuracy-grid">
        <MetricCard label="Samples" value={p.samples} />
        <MetricCard label="MAE" value={p.maeMs?.toFixed(1) || '0'} unit=" ms" />
        <MetricCard label="RMSE" value={p.rmseMs?.toFixed(1) || '0'} unit=" ms" />
        <MetricCard label="R²" value={p.r2?.toFixed(3) || '0'} />
        <MetricCard label="MAPE" value={(p.mape * 100).toFixed(1)} unit="%" />
      </div>
    </div>
  );
}