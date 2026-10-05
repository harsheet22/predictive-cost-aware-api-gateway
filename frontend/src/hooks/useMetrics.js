import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

/**
 * Hook for polling live metrics from both gateways
 */
export function useLiveMetrics(intervalMs = 1000) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await api.metricsLive();
      setData(res.gateways);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const timer = setInterval(fetchMetrics, intervalMs);
    return () => clearInterval(timer);
  }, [fetchMetrics, intervalMs]);

  return { data, loading, error, refetch: fetchMetrics };
}

/**
 * Hook for running comparison experiments
 */
export function useComparison() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async (config) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.compareRun(config);
      setResult(res);
      return res;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { result, loading, error, run, reset };
}

/**
 * Hook for ML service status
 */
export function useMLStatus(intervalMs = 5000) {
  const [health, setHealth] = useState(null);
  const [modelInfo, setModelInfo] = useState(null);

  const fetch = useCallback(async () => {
    try {
      const [h, m] = await Promise.all([api.mlHealth(), api.mlModelInfo()]);
      setHealth(h);
      setModelInfo(m);
    } catch (e) {
      setHealth({ status: 'error', modelLoaded: false });
      setModelInfo(null);
    }
  }, []);

  useEffect(() => {
    fetch();
    const timer = setInterval(fetch, intervalMs);
    return () => clearInterval(timer);
  }, [fetch, intervalMs]);

  return { health, modelInfo, refetch: fetch };
}