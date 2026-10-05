/**
 * API client for backend and ML service
 */
const BACKEND_URL = 'http://localhost:3000';
const ML_URL = 'http://localhost:8000';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Backend
  health: () => fetchJson(`${BACKEND_URL}/api/health`),
  metricsLive: () => fetchJson(`${BACKEND_URL}/api/metrics/live`),
  metricsReset: () => fetchJson(`${BACKEND_URL}/api/metrics/reset`, { method: 'POST' }),
  execute: (body) => fetchJson(`${BACKEND_URL}/api/execute`, { method: 'POST', body: JSON.stringify(body) }),
  compareRun: (body) => fetchJson(`${BACKEND_URL}/api/compare/run`, { method: 'POST', body: JSON.stringify(body) }),
  compareStream: (profile, seed) => fetchJson(`${BACKEND_URL}/api/compare/stream/${profile}/${seed}`),

  // ML Service
  mlHealth: () => fetchJson(`${ML_URL}/health`),
  mlModelInfo: () => fetchJson(`${ML_URL}/model/info`),
  mlPredict: (body) => fetchJson(`${ML_URL}/predict`, { method: 'POST', body: JSON.stringify(body) }),
  mlTrain: (body) => fetchJson(`${ML_URL}/train`, { method: 'POST', body: JSON.stringify(body) }),
};