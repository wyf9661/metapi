import { describe, expect, it } from 'vitest';
import { calculateProxyRequestLevelMetricsFromAggregates } from './proxyRequestAggregateMetrics.js';

describe('proxyRequestAggregateMetrics', () => {
  it('calculates first-try, rescued and exhausted requests from grouped rows', () => {
    expect(calculateProxyRequestLevelMetricsFromAggregates([
      {
        requestTraceId: 'r_first',
        attemptCount: 1,
        firstAttemptRetry: 0,
        firstSuccessRetry: 0,
        successCount: 1,
      },
      {
        requestTraceId: 'r_rescued',
        attemptCount: '3',
        firstAttemptRetry: 0,
        firstSuccessRetry: 2,
        successCount: '1',
      },
      {
        requestTraceId: 'r_failed',
        attemptCount: 2,
        firstAttemptRetry: 0,
        firstSuccessRetry: null,
        successCount: 0,
      },
    ])).toEqual({
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

  it('ignores legacy rows without trace ids', () => {
    expect(calculateProxyRequestLevelMetricsFromAggregates([
      { requestTraceId: null, attemptCount: 10, successCount: 10 },
    ]).requestCount).toBe(0);
  });
});
