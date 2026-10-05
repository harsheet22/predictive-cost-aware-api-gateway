import React from 'react';
import { MetricCard } from './MetricCard';

/**
 * ThroughputSummary - displays experiment throughput for both gateways
 */
function ThroughputSummary({ throughput }) {
  if (!throughput) return null;

  const { baseline, predictive } = throughput;

  return (
    <section className="card throughput-summary">
      <h2>Experiment Throughput (req/s)</h2>
      <div className="throughput-grid">
        {/* Incoming */}
        <MetricCard
          label="Incoming Throughput"
          value={baseline?.incomingPerSec || 0}
          unit=" req/s"
          delta={baseline?.incomingPerSec && predictive?.incomingPerSec
            ? ((predictive.incomingPerSec - baseline.incomingPerSec) / baseline.incomingPerSec * 100)
            : undefined}
        />

        {/* Processed */}
        <MetricCard
          label="Processed Throughput"
          value={predictive?.processedPerSec || 0}
          unit=" req/s"
          delta={baseline?.processedPerSec && predictive?.processedPerSec
            ? ((predictive.processedPerSec - baseline.processedPerSec) / baseline.processedPerSec * 100)
            : undefined}
        />

        {/* Rejected */}
        <MetricCard
          label="Rejected Throughput"
          value={predictive?.rejectedPerSec || 0}
          unit=" req/s"
          delta={baseline?.rejectedPerSec && predictive?.rejectedPerSec
            ? ((predictive.rejectedPerSec - baseline.rejectedPerSec) / baseline.rejectedPerSec * 100)
            : undefined}
        />

        {/* Delayed */}
        <MetricCard
          label="Delayed Throughput"
          value={predictive?.delayedPerSec || 0}
          unit=" req/s"
        />

        {/* Downgraded */}
        <MetricCard
          label="Downgraded Throughput"
          value={predictive?.downgradedPerSec || 0}
          unit=" req/s"
        />
      </div>

      {/* Comparison table */}
      <div className="throughput-table">
        <h3>Per-Gateway Breakdown</h3>
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Baseline</th>
              <th>Predictive</th>
              <th>Delta</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Incoming req/s</td>
              <td>{baseline?.incomingPerSec?.toFixed(1) || 0}</td>
              <td>{predictive?.incomingPerSec?.toFixed(1) || 0}</td>
              <td className={deltaClass(baseline?.incomingPerSec, predictive?.incomingPerSec)}>
                {deltaPercent(baseline?.incomingPerSec, predictive?.incomingPerSec)}
              </td>
            </tr>
            <tr>
              <td>Processed req/s</td>
              <td>{baseline?.processedPerSec?.toFixed(1) || 0}</td>
              <td>{predictive?.processedPerSec?.toFixed(1) || 0}</td>
              <td className={deltaClass(baseline?.processedPerSec, predictive?.processedPerSec)}>
                {deltaPercent(baseline?.processedPerSec, predictive?.processedPerSec)}
              </td>
            </tr>
            <tr>
              <td>Rejected req/s</td>
              <td>{baseline?.rejectedPerSec?.toFixed(1) || 0}</td>
              <td>{predictive?.rejectedPerSec?.toFixed(1) || 0}</td>
              <td className={deltaClass(baseline?.rejectedPerSec, predictive?.rejectedPerSec, true)}>
                {deltaPercent(baseline?.rejectedPerSec, predictive?.rejectedPerSec)}
              </td>
            </tr>
            <tr>
              <td>Delayed req/s</td>
              <td>{baseline?.delayedPerSec?.toFixed(1) || 0}</td>
              <td>{predictive?.delayedPerSec?.toFixed(1) || 0}</td>
              <td>{deltaPercent(baseline?.delayedPerSec, predictive?.delayedPerSec)}</td>
            </tr>
            <tr>
              <td>Downgraded req/s</td>
              <td>{baseline?.downgradedPerSec?.toFixed(1) || 0}</td>
              <td>{predictive?.downgradedPerSec?.toFixed(1) || 0}</td>
              <td>{deltaPercent(baseline?.downgradedPerSec, predictive?.downgradedPerSec)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function deltaClass(baseline, predictive, lowerIsBetter = false) {
  if (baseline === undefined || predictive === undefined) return '';
  const delta = predictive - baseline;
  if (delta === 0) return 'delta-neutral';
  if (lowerIsBetter) {
    return delta < 0 ? 'delta-positive' : 'delta-negative';
  }
  return delta > 0 ? 'delta-positive' : 'delta-negative';
}

function deltaPercent(baseline, predictive) {
  if (baseline === undefined || predictive === undefined || baseline === 0) return '—';
  return `${((predictive - baseline) / baseline * 100).toFixed(1)}%`;
}

export { ThroughputSummary };