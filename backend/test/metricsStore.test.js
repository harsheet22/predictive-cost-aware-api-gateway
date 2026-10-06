'use strict';

/**
 * Tests for MetricsStore throughput calculation
 */

const MetricsStore = require('../src/metrics/metricsStore');

describe('MetricsStore', () => {
  let metrics;

  beforeEach(() => {
    metrics = new MetricsStore('test');
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    clearInterval(metrics._timer);
  });

  describe('experiment throughput', () => {
    test('should calculate experiment throughput using configured duration', () => {
      metrics.markExperimentStart(5); // 5 second workload

      // Simulate 100 requests over 1 second wall time
      for (let i = 0; i < 100; i++) {
        metrics.begin();
        metrics.record({
          decision: 'ALLOW',
          status: 200,
          latencyMs: 10,
          slaMet: true,
          actualCostMs: 5,
          actualCostUsd: 0.000001,
          predictedCostMs: 5,
          predictedCostUsd: 0.000001,
        });
      }

      // Advance time by 1 second (wall clock)
      jest.advanceTimersByTime(1000);

      metrics.markExperimentEnd();

      const snapshot = metrics.snapshot();
      // Throughput should use 5-second configured duration, not 1-second wall time
      expect(snapshot.experimentThroughput.incomingPerSec).toBe(20); // 100/5
      expect(snapshot.experimentThroughput.processedPerSec).toBe(20); // 100/5
    });

    test('should calculate throughput over multiple seconds using configured duration', () => {
      metrics.markExperimentStart(2); // 2 second workload

      // Simulate 50 requests over 1 second wall time
      for (let i = 0; i < 50; i++) {
        metrics.begin();
        metrics.record({
          decision: 'ALLOW',
          status: 200,
          latencyMs: 10,
          slaMet: true,
        });
      }

      jest.advanceTimersByTime(1000);

      metrics.markExperimentEnd();

      const snapshot = metrics.snapshot();
      // Throughput should use 2-second configured duration, not 1-second wall time
      expect(snapshot.experimentThroughput.incomingPerSec).toBe(25); // 50/2
      expect(snapshot.experimentThroughput.processedPerSec).toBe(25); // 50/2
    });

    test('should handle mixed decisions using configured duration', () => {
      metrics.markExperimentStart(2); // 2 second workload

      // 80 ALLOW, 10 REJECT, 10 DELAY over 1 second wall time
      for (let i = 0; i < 80; i++) {
        metrics.begin();
        metrics.record({
          decision: 'ALLOW',
          status: 200,
          latencyMs: 10,
          slaMet: true,
        });
      }
      for (let i = 0; i < 10; i++) {
        metrics.begin();
        metrics.record({
          decision: 'REJECT',
          status: 429,
          latencyMs: 0,
          slaMet: false,
        });
      }
      for (let i = 0; i < 10; i++) {
        metrics.begin();
        metrics.record({
          decision: 'DELAY',
          status: 200,
          latencyMs: 100,
          slaMet: true,
        });
      }

      jest.advanceTimersByTime(1000);

      metrics.markExperimentEnd();

      const snapshot = metrics.snapshot();
      // Throughput should use 2-second configured duration
      expect(snapshot.experimentThroughput.incomingPerSec).toBe(50); // 100/2
      expect(snapshot.experimentThroughput.processedPerSec).toBe(45); // (80+10)/2
      expect(snapshot.experimentThroughput.rejectedPerSec).toBe(5); // 10/2
      expect(snapshot.experimentThroughput.delayedPerSec).toBe(5); // 10/2
      expect(snapshot.experimentThroughput.downgradedPerSec).toBe(0);
    });

    test('should handle downgraded requests using configured duration', () => {
      metrics.markExperimentStart(1); // 1 second workload

      for (let i = 0; i < 20; i++) {
        metrics.begin();
        metrics.record({
          decision: 'DOWNGRADE',
          status: 200,
          latencyMs: 10,
          slaMet: true,
        });
      }

      jest.advanceTimersByTime(1000);

      metrics.markExperimentEnd();

      const snapshot = metrics.snapshot();
      expect(snapshot.experimentThroughput.downgradedPerSec).toBe(20); // 20/1
      expect(snapshot.experimentThroughput.processedPerSec).toBe(20); // 20/1
    });

    test('should handle zero duration edge case', () => {
      metrics.markExperimentStart(0);

      for (let i = 0; i < 10; i++) {
        metrics.begin();
        metrics.record({
          decision: 'ALLOW',
          status: 200,
          latencyMs: 10,
          slaMet: true,
        });
      }

      metrics.markExperimentEnd();

      const snapshot = metrics.snapshot();
      // Duration 0 should be handled gracefully
      expect(snapshot.experimentThroughput.incomingPerSec).toBe(0);
    });
  });

  describe('sliding window rps (real-time)', () => {
    test('should calculate rps from sliding window', () => {
      for (let i = 0; i < 10; i++) {
        metrics.begin();
        metrics.record({
          decision: 'ALLOW',
          status: 200,
          latencyMs: 10,
          slaMet: true,
        });
      }

      jest.advanceTimersByTime(1000);
      metrics._sample();

      const snapshot = metrics.snapshot();
      expect(snapshot.rps).toBe(10);
    });

    test('should decay rps as window slides', () => {
      for (let i = 0; i < 10; i++) {
        metrics.begin();
        metrics.record({
          decision: 'ALLOW',
          status: 200,
          latencyMs: 10,
          slaMet: true,
        });
      }

      jest.advanceTimersByTime(1000);
      metrics._sample();

      jest.advanceTimersByTime(5000);
      metrics._sample();

      const snapshot = metrics.snapshot();
      expect(snapshot.rps).toBe(0);
    });
  });

  describe('experiment throughput vs sliding window rps', () => {
    test('experiment throughput should persist after window slides', () => {
      metrics.markExperimentStart(1); // 1 second workload

      for (let i = 0; i < 100; i++) {
        metrics.begin();
        metrics.record({
          decision: 'ALLOW',
          status: 200,
          latencyMs: 10,
          slaMet: true,
        });
      }

      jest.advanceTimersByTime(1000);
      metrics.markExperimentEnd();

      // Advance time past the sliding window
      jest.advanceTimersByTime(6000);
      metrics._sample();

      const snapshot = metrics.snapshot();
      // rps should be 0 (outside window)
      expect(snapshot.rps).toBe(0);
      // But experiment throughput should persist using configured duration
      expect(snapshot.experimentThroughput.incomingPerSec).toBe(100);
      expect(snapshot.experimentThroughput.processedPerSec).toBe(100);
    });
  });

  test('records actual final reasons separately without changing decision or accuracy totals', () => {
    for (const reason of ['cheap_and_budget_ok', 'high_priority_budget_ok', 'cheap_and_budget_ok']) {
      metrics.begin();
      metrics.record({ decision: 'ALLOW', reason, status: 200, latencyMs: 300,
        slaMet: false, predictedCostMs: 20, actualCostMs: 30 });
    }
    expect(metrics.snapshot()).toMatchObject({ allowed: 3, processed: 3, slaMet: 0,
      latency: { avg: 300 }, prediction: { samples: 3, maeMs: 10, rmseMs: 10 },
      decisionReasons: [
        { decision: 'ALLOW', reason: 'cheap_and_budget_ok', count: 2 },
        { decision: 'ALLOW', reason: 'high_priority_budget_ok', count: 1 },
      ] });
    metrics.reset();
    expect(metrics.snapshot().decisionReasons).toEqual([]);
  });

  test('retains real timestamped phase costs, including final totals, until reset', () => {
    metrics.markExperimentStart(5);
    metrics.begin();
    metrics.record({ decision: 'ALLOW', status: 200, latencyMs: 10, slaMet: true,
      actualCostUsd: 0.000002, predictedCostUsd: 0.000001 });
    jest.advanceTimersByTime(1000);
    metrics._sample();
    metrics.markExperimentEnd();
    const snapshot = metrics.snapshot();
    expect(snapshot.costHistory[0]).toMatchObject({ phase: 'test', actualCostUsd: 0 });
    expect(snapshot.costHistory.at(-1)).toMatchObject({ phase: 'test',
      actualCostUsd: snapshot.cost.estimatedCloudCostUsd,
      predictedCostUsd: snapshot.cost.predictedCloudCostUsd });
    expect(snapshot.costHistory.at(-1).timestamp).toBe(snapshot.experiment.endedAt);
    expect(snapshot.experiment.durationSec).toBe(5);
    jest.advanceTimersByTime(6000);
    metrics._sample();
    expect(metrics.snapshot().costHistory).toEqual(snapshot.costHistory);
    metrics.reset();
    expect(metrics.snapshot()).toMatchObject({ costHistory: [], experiment: {
      startedAt: null, endedAt: null, durationSec: null } });
  });

  test('bounds cost history while retaining the initial and latest samples', () => {
    metrics.markExperimentStart(1000);
    const first = metrics.snapshot().costHistory[0];
    for (let i = 0; i < 700; i++) {
      metrics.totalActualCostUsd = i / 1000000;
      metrics._sample();
    }
    const samples = metrics.snapshot().costHistory;
    expect(samples).toHaveLength(600);
    expect(samples[0]).toEqual(first);
    expect(samples.at(-1).actualCostUsd).toBe(0.000699);
  });
});
