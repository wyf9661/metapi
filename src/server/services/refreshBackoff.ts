/**
 * Shared refresh-failure backoff for token refresh schedulers.
 *
 * Both sub2api managed sessions and OAuth access tokens refresh on a fixed
 * interval once their expiry approaches. If the upstream keeps rejecting the
 * refresh request (HTTP 405/401, network down), the account stays "due"
 * forever and the scheduler would hammer the site every tick. This module is
 * the single implementation of the retry-window policy both schedulers use:
 *
 *   - fail N times   -> wait base * 2^(N-1), capped at max (5m -> 60m)
 *   - a retryAtMs in the future means "skip this account this pass"
 *   - a successful refresh resets the counter (caller clears the state)
 */

/** Base backoff for repeated refresh failures (5 minutes). */
export const REFRESH_BACKOFF_BASE_MS = 5 * 60 * 1000;

/** Cap for refresh failure backoff (60 minutes). */
export const REFRESH_BACKOFF_MAX_MS = 60 * 60 * 1000;

/** Resolve the wait duration for a given consecutive-failure count. */
export function resolveRefreshBackoffMs(failCount: number): number {
  if (!Number.isFinite(failCount) || failCount <= 0) return 0;
  const exponent = Math.min(failCount - 1, 8);
  return Math.min(
    REFRESH_BACKOFF_BASE_MS * (2 ** exponent),
    REFRESH_BACKOFF_MAX_MS,
  );
}

/**
 * True when the account is inside its failure-backoff window and the scheduler
 * should skip it for this pass.
 */
export function isRefreshBackoffActive(
  retryAtMs: number | null | undefined,
  nowMs: number,
): boolean {
  return typeof retryAtMs === 'number' && Number.isFinite(retryAtMs) && retryAtMs > nowMs;
}

/**
 * Advance the backoff state after another failed refresh attempt.
 * Returns the next fail count and the timestamp at which retrying is allowed.
 */
export function advanceRefreshBackoff(
  previousFailCount: number | null | undefined,
  nowMs: number,
): { failCount: number; retryAtMs: number } {
  const previous = typeof previousFailCount === 'number' && Number.isFinite(previousFailCount)
    ? Math.trunc(previousFailCount)
    : 0;
  const failCount = Math.max(0, previous) + 1;
  return {
    failCount,
    retryAtMs: nowMs + resolveRefreshBackoffMs(failCount),
  };
}
