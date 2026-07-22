export type ProxyRequestAggregateRow = {
  requestTraceId?: string | null;
  attemptCount?: number | string | null;
  firstAttemptAt?: string | null;
  firstSuccessAt?: string | null;
  successCount?: number | string | null;
};

export type ProxyRequestLevelMetrics = {
  requestCount: number;
  firstTrySuccessCount: number;
  rescuedCount: number;
  exhaustedCount: number;
  averageAttempts: number | null;
  firstTrySuccessRatePercent: number | null;
  rescueRatePercent: number | null;
  exhaustedRatePercent: number | null;
  failoverShareOfSuccessPercent: number | null;
};

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Calculate request-level metrics from SQL GROUP BY request_trace_id rows.
 * Attempt rows stay in the database; Node receives one compact row per request.
 */
export function calculateProxyRequestLevelMetricsFromAggregates(
  rows: ProxyRequestAggregateRow[],
): ProxyRequestLevelMetrics {
  let firstTrySuccessCount = 0;
  let rescuedCount = 0;
  let exhaustedCount = 0;
  let attemptTotal = 0;
  let requestCount = 0;

  for (const row of rows) {
    if (!String(row.requestTraceId || '').trim()) continue;
    requestCount += 1;
    attemptTotal += Math.max(0, numeric(row.attemptCount));
    const successCount = Math.max(0, numeric(row.successCount));
    if (successCount <= 0 || !row.firstSuccessAt) {
      exhaustedCount += 1;
    } else if (row.firstSuccessAt === row.firstAttemptAt) {
      firstTrySuccessCount += 1;
    } else {
      rescuedCount += 1;
    }
  }

  const successCount = firstTrySuccessCount + rescuedCount;
  const rate = (count: number): number | null => (
    requestCount > 0 ? Math.round((count / requestCount) * 1000) / 10 : null
  );

  return {
    requestCount,
    firstTrySuccessCount,
    rescuedCount,
    exhaustedCount,
    averageAttempts: requestCount > 0
      ? Math.round((attemptTotal / requestCount) * 100) / 100
      : null,
    firstTrySuccessRatePercent: rate(firstTrySuccessCount),
    rescueRatePercent: rate(rescuedCount),
    exhaustedRatePercent: rate(exhaustedCount),
    failoverShareOfSuccessPercent: successCount > 0
      ? Math.round((rescuedCount / successCount) * 1000) / 10
      : null,
  };
}
