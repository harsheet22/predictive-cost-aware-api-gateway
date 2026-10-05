import React from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, Cell
} from 'recharts';

/**
 * ComparisonChart - side-by-side bar chart for latency percentiles, throughput, etc.
 */
export function ComparisonChart({
  data,
  keys,
  labels,
  title,
  unit = '',
  height = 280,
}) {
  const COLORS = ['#3b82f6', '#10b981']; // blue, green

  return (
    <div className="chart-container">
      {title && <h3 className="chart-title">{title}</h3>}
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis type="number" tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 11 }} />
          <Tooltip
            formatter={(value, name) => [value + unit, labels[name] || name]}
            labelFormatter={(label) => label}
          />
          <Legend />
          {keys.map((key, i) => (
            <Bar key={key} dataKey={key} fill={COLORS[i]} radius={[0, 4, 4, 0]} maxBarSize={30}>
              {data.map((_, idx) => (
                <Cell key={`cell-${key}-${idx}`} fill={COLORS[i]} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * LatencyPercentileChart - specialized for p50/p90/p95/p99
 */
export function LatencyPercentileChart({ baseline, predictive }) {
  const data = [
    { name: 'p50', baseline: baseline?.p50 || 0, predictive: predictive?.p50 || 0 },
    { name: 'p90', baseline: baseline?.p90 || 0, predictive: predictive?.p90 || 0 },
    { name: 'p95', baseline: baseline?.p95 || 0, predictive: predictive?.p95 || 0 },
    { name: 'p99', baseline: baseline?.p99 || 0, predictive: predictive?.p99 || 0 },
  ];

  return (
    <ComparisonChart
      data={data}
      keys={['baseline', 'predictive']}
      labels={{ baseline: 'Baseline', predictive: 'Predictive' }}
      title="Latency Percentiles"
      unit=" ms"
    />
  );
}

/**
 * ThroughputChart - baseline vs predictive RPS
 */
export function ThroughputChart({ baseline, predictive }) {
  const data = [
    { name: 'Throughput', baseline: baseline?.rps || 0, predictive: predictive?.rps || 0 },
  ];

  return (
    <ComparisonChart
      data={data}
      keys={['baseline', 'predictive']}
      labels={{ baseline: 'Baseline', predictive: 'Predictive' }}
      title="Throughput (req/s)"
      unit=""
      height={180}
    />
  );
}