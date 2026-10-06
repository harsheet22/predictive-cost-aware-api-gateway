import React, { useState } from 'react';
import { api } from '../api/client';

const PROFILES = [
  { id: 'light', label: 'Light', desc: '8 req/s, mostly DB queries' },
  { id: 'normal', label: 'Normal', desc: '25 req/s, mixed workload' },
  { id: 'mixed', label: 'Mixed', desc: '40 req/s, balanced' },
  { id: 'burst', label: 'Burst', desc: '80 req/s, high volume' },
  { id: 'heavy_tail', label: 'Heavy Tail', desc: '45 req/s, many reports' },
  { id: 'stress', label: 'Stress', desc: '200 req/s, CPU-heavy' },
  { id: 'overload', label: 'Overload', desc: '500 req/s, extreme' },
  { id: 'demo', label: 'Demo', desc: '120 req/s, mixed workload' },
];

/**
 * SimulatorControls - configure and run comparison experiments
 */
export function SimulatorControls({ onRun, running, lastResult }) {
  const [profile, setProfile] = useState('demo');
  const [duration, setDuration] = useState(5);
  const [seed, setSeed] = useState(42);
  const [error, setError] = useState(null);

  const handleRun = async () => {
    setError(null);
    try {
      await onRun({ profile, durationSec: duration, seed });
    } catch (e) {
      setError(e.message);
    }
  };

  const handleReset = () => {
    api.metricsReset().catch(console.error);
  };

  return (
    <div className="simulator-controls">
      <h3 className="chart-title">Experiment Controls</h3>

      <div className="controls-layout">
      <div className="control-group">
        <label htmlFor="workload-profile">Workload Profile</label>
        <select id="workload-profile" value={profile} onChange={(e) => setProfile(e.target.value)} disabled={running}>
          {PROFILES.map((p) => (
            <option key={p.id} value={p.id}>{p.label} — {p.desc}</option>
          ))}
        </select>
      </div>

      <div className="control-row">
        <div className="control-group">
          <label htmlFor="workload-duration">Duration (seconds)</label>
          <input
            type="number"
            id="workload-duration"
            min="1"
            max="300"
            value={duration}
            onChange={(e) => setDuration(parseInt(e.target.value) || 1)}
            disabled={running}
          />
        </div>
        <div className="control-group">
          <label htmlFor="workload-seed">Random Seed</label>
          <input
            type="number"
            id="workload-seed"
            min="0"
            max="999999"
            value={seed}
            onChange={(e) => setSeed(parseInt(e.target.value) || 0)}
            disabled={running}
          />
        </div>
      </div>

      <div className="control-actions">
        <button
          className="btn btn-primary"
          onClick={handleRun}
          disabled={running}
        >
          {running ? 'Running...' : 'Run Comparison'}
        </button>
        <button className="btn btn-secondary" onClick={handleReset} disabled={running}>
          Reset Metrics
        </button>
      </div>

      </div>

      {error && <div className="control-error">{error}</div>}

      {lastResult && (
        <div className="last-run-summary">
          <h4>Last Run: {lastResult.profile} ({lastResult.durationSec}s, seed {lastResult.seed})</h4>
          <div className="last-run-facts">
            <span>Baseline processed <strong>{lastResult.baseline?.processed || 0}</strong></span>
            <span>Cost savings <strong>{(lastResult.savings?.percent || 0).toFixed(1)}%</strong></span>
            <span>SLA delta <strong>{lastResult.savings?.slaMetDelta || 0}</strong></span>
          </div>
        </div>
      )}
    </div>
  );
}
