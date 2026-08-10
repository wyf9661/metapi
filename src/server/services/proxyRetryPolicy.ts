import {
  classifyProxyFailure,
  shouldAbortSameSiteEndpointForFailure,
  shouldRetryChannelForFailure,
  type SiteRuntimeFailureContext,
  RETRYABLE_TIMEOUT_PATTERNS as SHARED_RETRYABLE_TIMEOUT_PATTERNS,
} from './siteFailureClassification.js';

// Re-export shared timeout patterns for existing importers.
export const RETRYABLE_TIMEOUT_PATTERNS = SHARED_RETRYABLE_TIMEOUT_PATTERNS;

/**
 * Protocol / policy failures that will not improve by switching channel with the
 * same client request shape (after in-channel endpoint cascade already ran).
 * Fail fast instead of burning the multi-channel retry budget.
 */
export function isNonRetryableProtocolPolicyError(upstreamErrorText?: string | null): boolean {
  return classifyProxyFailure({ errorText: upstreamErrorText }).class === 'protocol_policy';
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

export function classifyProxyRequestFailure(
  status: number,
  upstreamErrorText?: string | null,
  modelName?: string | null,
): ReturnType<typeof classifyProxyFailure> {
  const context: SiteRuntimeFailureContext = {
    status,
    errorText: upstreamErrorText,
    modelName,
  };
  return classifyProxyFailure(context);
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
  if (status === 429) return true;
  if (status >= 500) return true;
  const decision = classifyProxyFailure({ status, errorText: upstreamErrorText || '' });
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
