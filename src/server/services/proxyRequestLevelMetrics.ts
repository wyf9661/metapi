export type ProxyRequestAttemptRow = {
  requestTraceId?: string | null;
  status?: string | null;
  retryCount?: number | null;
  createdAt?: string | null;
};

export type ProxyRequestLevelMetrics = {
  /** Distinct request_trace_id values observed. */
  requestCount: number;
  /** Requests whose first attempt (retryCount=0 or min) succeeded. */
  firstTrySuccessCount: number;
  /** Requests that failed early attempt(s) then later succeeded. */
  rescuedCount: number;
  /** Requests with no successful attempt. */
  exhaustedCount: number;
  /** Mean attempts per request. */
  averageAttempts: number | null;
  firstTrySuccessRatePercent: number | null;
  rescueRatePercent: number | null;
  exhaustedRatePercent: number | null;
  /** Share of successful requests that needed failover (rescued / successes). */
  failoverShareOfSuccessPercent: number | null;
};

function normalizeTraceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSuccess(status: unknown): boolean {
  return String(status || '').trim().toLowerCase() === 'success';
}

/**
 * Collapse attempt-level proxy_logs into request-level failover metrics.
 * Rows without requestTraceId are ignored so legacy data does not pollute rates.
 */
export function calculateProxyRequestLevelMetrics(
  rows: ProxyRequestAttemptRow[],
): ProxyRequestLevelMetrics {
  const byTrace = new Map<string, ProxyRequestAttemptRow[]>();
  for (const row of rows) {
    const traceId = normalizeTraceId(row.requestTraceId);
    if (!traceId) continue;
    const bucket = byTrace.get(traceId);
    if (bucket) bucket.push(row);
    else byTrace.set(traceId, [row]);
  }

  let firstTrySuccessCount = 0;
  let rescuedCount = 0;
  let exhaustedCount = 0;
  let attemptTotal = 0;

  for (const attempts of byTrace.values()) {
    attemptTotal += attempts.length;
    const ordered = [...attempts].sort((left, right) => {
      const leftRetry = Number(left.retryCount ?? 0);
      const rightRetry = Number(right.retryCount ?? 0);
      if (leftRetry !== rightRetry) return leftRetry - rightRetry;
      return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    });
    const anySuccess = ordered.some((row) => isSuccess(row.status));
    const first = ordered[0];
    const firstSuccess = first ? isSuccess(first.status) : false;
    if (firstSuccess) {
      firstTrySuccessCount += 1;
    } else if (anySuccess) {
      rescuedCount += 1;
    } else {
      exhaustedCount += 1;
    }
  }

  const requestCount = byTrace.size;
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
