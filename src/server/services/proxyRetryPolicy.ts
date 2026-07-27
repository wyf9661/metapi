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
