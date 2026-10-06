import React from 'react';

/**
 * MetricCard - displays a single metric with label, value, and optional delta
 */
export function MetricCard({ label, value, delta, unit = '', className = '', description }) {
  const deltaColor = delta === undefined ? 'gray'
    : delta > 0 ? 'green'
    : delta < 0 ? 'red' : 'gray';

  return (
    <div className={`metric-card ${className}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      {description && <p className="metric-description">{description}</p>}
      {delta !== undefined && (
        <div className="metric-delta" style={{ color: deltaColor }}>
          {delta > 0 ? '▲' : delta < 0 ? '▼' : '●'} {Math.abs(delta).toFixed(1)}%
        </div>
      )}
    </div>
  );
}

export function MetricRow({ baseline, predictive, label, format = (v) => v }) {
  return (
    <div className="metric-row">
      <span className="metric-row-label">{label}</span>
      <span className="metric-row-baseline">{format(baseline)}</span>
      <span className="metric-row-predictive">{format(predictive)}</span>
    </div>
  );
}
