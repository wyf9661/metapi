import {
  classifyProxyFailure,
  isEmptyContentFailureText,
  shouldAbortSameSiteEndpointForFailure,
  shouldRetryChannelForFailure,
  RETRYABLE_TIMEOUT_PATTERNS as SHARED_RETRYABLE_TIMEOUT_PATTERNS,
} from './siteFailureClassification.js';

// Re-export shared timeout patterns for existing importers.
export const RETRYABLE_TIMEOUT_PATTERNS = SHARED_RETRYABLE_TIMEOUT_PATTERNS;

// Re-export the empty-content predicate: it is defined next to the failure
// taxonomy so the retry policy and the site-exclusion rule cannot drift apart.
export { isEmptyContentFailureText };

/**
 * Protocol / policy failures that will not improve by switching channel with the
 * same client request shape (after in-channel endpoint cascade already ran).
 * Fail fast instead of burning the multi-channel retry budget.
 */
export function isNonRetryableProtocolPolicyError(upstreamErrorText?: string | null): boolean {
  return classifyProxyFailure({ errorText: upstreamErrorText }).class === 'protocol_policy';
}

export function shouldInPlaceRetryEmptyContentOnce(
  alreadyRetried: boolean,
  upstreamErrorText?: string | null,
): boolean {
  return !alreadyRetried && isEmptyContentFailureText(upstreamErrorText);
}

/**
 * Whether failing over to another upstream channel is worthwhile.
 *
 * Driven by the shared failure taxonomy so cascade / retry / cooldown stay aligned.
 */
export function shouldRetryProxyRequest(status: number, upstreamErrorText?: string | null): boolean {
  return shouldRetryChannelForFailure({ status, errorText: upstreamErrorText });
}

/**
 * Whether remaining same-site endpoints should be abandoned after this failure.
 * true = stop cascade and leave the site.
 */
export function shouldAbortSameSiteEndpointFallback(status: number, upstreamErrorText?: string | null): boolean {
  return shouldAbortSameSiteEndpointForFailure({ status, errorText: upstreamErrorText });
}


/**
 * Whether this failure belongs to the "recovers within seconds" family that
 * benefits from a short pause before the next channel attempt: WAF/edge 403
 * blocks, bare 403 forbidden, rate limits (429) and 5xx origin errors.
 *
 * Credential-death 401 and request-shape 400/422 are intentionally excluded:
 * pausing would only add latency to failures that will not self-heal.
 */
export function isRecoveringTransientFailure(status: number, upstreamErrorText?: string | null): boolean {
  // A full per-minute bucket is a capacity state with its own wait-and-resend
  // path (resolveMinuteRateLimitRetryWaitMs). Treating it as a recovering
  // transient would additionally burn the generic grace retry on the same
  // channel, so the request waits twice for the same window.
  if (classifyProxyFailure({ status, errorText: upstreamErrorText }).class === 'minute_rate_limit') return false;
  // A 200-with-empty-body ('Upstream returned empty content') is a persisted
  // channel defect — the relay answers instantly with nothing — not an edge
  // block that clears within seconds. Same-channel grace/in-place retries only
  // burn the failover budget (observed: three same-channel attempts in 7s on a
  // dead relay channel), so fail over to the next channel immediately.
  if (isEmptyContentFailureText(upstreamErrorText)) return false;
  if (status === 429) return true;
  if (status >= 500) return true;
  const decision = classifyProxyFailure({ status, errorText: upstreamErrorText || '' });
  // Site/organization-level credential death is permanent, never recovering.
  if (decision.class === 'credential_invalid') return false;
  if (decision.class === 'waf_blocked') return true;
  // Bare 403/forbidden: WAF vocabulary may be absent (e.g. Nginx/CF without
  // the usual body) yet the block is still temporary edge filtering.
  if (status === 403 && /forbidden/i.test(upstreamErrorText || '')) return true;
  return false;
}

/**
 * Short backoff before the next failover attempt after a transient-recovering
 * failure. Returns 0 when the feature is disabled (config default) or the
 * failure is not in the recovering family, preserving legacy immediate
 * failover behavior.
 */
export function resolveFailoverBackoffMs(
  status: number,
  upstreamErrorText?: string | null,
  backoffMs = 0,
): number {
  if (backoffMs <= 0) return 0;
  if (!isRecoveringTransientFailure(status, upstreamErrorText)) return 0;
  return backoffMs;
}

export function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extra wall-clock a request may spend waiting for a full minute bucket. */
export const MINUTE_RATE_LIMIT_MAX_WAIT_MS = 15_000;
/** Wait used when the rejection carries no reset hint (one bucket window). */
export const MINUTE_RATE_LIMIT_DEFAULT_WAIT_MS = 5_000;

/**
 * How long to wait before resending on the SAME channel after a short-window
 * rate limit. The upstream hint wins (it is the only party that knows when the
 * bucket refills); without one we assume a few seconds. Bounded by the request's
 * own wait budget and allowed exactly once: a bucket that is still full after
 * the wait is upstream state, and another site is then the better answer.
 */
export function resolveMinuteRateLimitRetryWaitMs(input: {
  alreadyRetried: boolean;
  waitedMs: number;
  upstreamRetryAfterMs?: number | null;
  budgetMs?: number;
}): number {
  if (input.alreadyRetried) return 0;
  const budgetMs = Math.max(0, Math.trunc(input.budgetMs ?? MINUTE_RATE_LIMIT_MAX_WAIT_MS));
  const remainingMs = budgetMs - Math.max(0, Math.trunc(input.waitedMs || 0));
  if (remainingMs <= 0) return 0;
  const hintMs = typeof input.upstreamRetryAfterMs === 'number' && Number.isFinite(input.upstreamRetryAfterMs)
    && input.upstreamRetryAfterMs > 0
    ? Math.trunc(input.upstreamRetryAfterMs)
    : MINUTE_RATE_LIMIT_DEFAULT_WAIT_MS;
  return Math.min(hintMs, remainingMs);
}

/**
 * Whether a single retry of the same channel is worth attempting after the
 * regular failover budget is exhausted. Transient-recovering failures (403
 * blocks, 429, 5xx) can clear within seconds; when the request already burned
 * through every candidate (e.g. a model served by a single site), one extra
 * attempt after the backoff window lets the recovery be observed instead of
 * failing fast.
 *
 * Limited to one in-place retry (retryCount === 0) so a stuck upstream cannot
 * turn this into an infinite loop; multi-channel pools still prefer normal
 * failover which is handled by the caller.
 */
export function canRetryInPlaceForRecoveringFailure(
  retryCount: number,
  status: number,
  upstreamErrorText?: string | null,
  backoffMs = 0,
): boolean {
  if (backoffMs <= 0) return false;
  if (retryCount !== 0) return false;
  return isRecoveringTransientFailure(status, upstreamErrorText);
}

/**
 * Whether to stay on the same channel during a time-boxed grace window
 * when a transient-recovering failure occurs. Gives WAF 403 / 429 / 5xx
 * blocks a chance to self-heal before the normal multi-channel failover
 * cascade engages.
 *
 * Returns true when ALL of the following hold:
 *   - graceMs > 0 (feature enabled)
 *   - elapsedMs >= 0 and < graceMs (still within the grace window)
 *   - failure is classified as a recovering transient failure
 *
 * The caller must NOT increment retryCount when this returns true, so the
 * failover budget is preserved for genuine multi-channel fallback.
 */
export function shouldGraceRetryInPlace(
  elapsedMs: number,
  graceMs: number,
  status: number,
  upstreamErrorText?: string | null,
): boolean {
  if (graceMs <= 0) return false;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  if (elapsedMs >= graceMs) return false;
  return isRecoveringTransientFailure(status, upstreamErrorText);
}

/**
 * Grace-window same-channel retry bounded to ONE per request.
 *
 * The grace window exists because WAF 403 / 429 / 5xx often clear within
 * seconds (a slow-but-alive relay may just need more time). But a block that
 * survives the FIRST grace retry is unlikely to clear within the same window,
 * so a second same-channel retry only burns time that a different channel
 * could use. Returns true only when the caller has not yet used its one
 * in-place grace retry AND the failure is still inside the grace window.
 */
export function shouldGraceRetryInPlaceOnce(
  alreadyGraceRetried: boolean,
  elapsedMs: number,
  graceMs: number,
  status: number,
  upstreamErrorText?: string | null,
): boolean {
  if (alreadyGraceRetried) return false;
  return shouldGraceRetryInPlace(elapsedMs, graceMs, status, upstreamErrorText);
}
