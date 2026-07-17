import { describe, expect, it } from 'vitest';
import {
  calculateProxyQualityMetrics,
  percentileNearestRank,
} from './proxyQualityMetrics.js';

describe('proxyQualityMetrics', () => {
  it('computes nearest-rank p95 while ignoring invalid values', () => {
    const values = Array.from({ length: 20 }, (_, index) => (index + 1) * 100);
    expect(percentileNearestRank(values, 0.95)).toBe(1900);
    expect(percentileNearestRank([null, -1, Number.NaN, 120], 0.95)).toBe(120);
    expect(percentileNearestRank([], 0.95)).toBeNull();
  });

  it('builds success rate, latency p95 and sparse marker', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      status: index < 18 ? 'success' : 'failed',
      firstByteLatencyMs: (index + 1) * 10,
      latencyMs: (index + 1) * 100,
    }));
    expect(calculateProxyQualityMetrics(rows)).toEqual({
      sampleCount: 20,
      successRatePercent: 90,
      p95FirstByteLatencyMs: 190,
      p95LatencyMs: 1900,
      sparse: false,
    });
  });

  it('marks small windows sparse and preserves null latency metrics', () => {
    expect(calculateProxyQualityMetrics([
      { status: 'success', firstByteLatencyMs: null, latencyMs: null },
    ])).toEqual({
      sampleCount: 1,
      successRatePercent: 100,
      p95FirstByteLatencyMs: null,
      p95LatencyMs: null,
      sparse: true,
    });
  });
});
