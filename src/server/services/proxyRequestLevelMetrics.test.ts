import { describe, expect, it } from 'vitest';
import { calculateProxyRequestLevelMetrics } from './proxyRequestLevelMetrics.js';

describe('proxyRequestLevelMetrics', () => {
  it('ignores attempt rows without requestTraceId', () => {
    expect(calculateProxyRequestLevelMetrics([
      { status: 'success', retryCount: 0 },
      { requestTraceId: '  ', status: 'failed', retryCount: 0 },
    ])).toEqual({
      requestCount: 0,
      firstTrySuccessCount: 0,
      rescuedCount: 0,
      exhaustedCount: 0,
      averageAttempts: null,
      firstTrySuccessRatePercent: null,
      rescueRatePercent: null,
      exhaustedRatePercent: null,
      failoverShareOfSuccessPercent: null,
    });
  });

  it('classifies first-try success, rescued and exhausted requests', () => {
    const metrics = calculateProxyRequestLevelMetrics([
      { requestTraceId: 'r_a', status: 'success', retryCount: 0, createdAt: '2026-07-22 01:00:00' },
      { requestTraceId: 'r_b', status: 'failed', retryCount: 0, createdAt: '2026-07-22 01:00:01' },
      { requestTraceId: 'r_b', status: 'success', retryCount: 1, createdAt: '2026-07-22 01:00:02' },
      { requestTraceId: 'r_c', status: 'failed', retryCount: 0, createdAt: '2026-07-22 01:00:03' },
      { requestTraceId: 'r_c', status: 'failed', retryCount: 1, createdAt: '2026-07-22 01:00:04' },
      { requestTraceId: 'r_c', status: 'failed', retryCount: 2, createdAt: '2026-07-22 01:00:05' },
    ]);

    expect(metrics).toEqual({
      requestCount: 3,
      firstTrySuccessCount: 1,
      rescuedCount: 1,
      exhaustedCount: 1,
      averageAttempts: 2,
      firstTrySuccessRatePercent: 33.3,
      rescueRatePercent: 33.3,
      exhaustedRatePercent: 33.3,
      failoverShareOfSuccessPercent: 50,
    });
  });

  it('orders attempts by retryCount then createdAt', () => {
    const metrics = calculateProxyRequestLevelMetrics([
      { requestTraceId: 'r_d', status: 'success', retryCount: 1, createdAt: '2026-07-22 02:00:02' },
      { requestTraceId: 'r_d', status: 'failed', retryCount: 0, createdAt: '2026-07-22 02:00:01' },
    ]);
    expect(metrics.firstTrySuccessCount).toBe(0);
    expect(metrics.rescuedCount).toBe(1);
    expect(metrics.exhaustedCount).toBe(0);
  });
});
