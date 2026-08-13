import { describe, expect, it } from 'vitest';
import {
  canRetryInPlaceForRecoveringFailure,
  isNonRetryableProtocolPolicyError,
  isRecoveringTransientFailure,
  resolveFailoverBackoffMs,
  shouldAbortSameSiteEndpointFallback,
  shouldGraceRetryInPlace,
  shouldGraceRetryInPlaceOnce,
  shouldRetryProxyRequest,
} from './proxyRetryPolicy.js';

describe('proxyRetryPolicy', () => {
  it('retries on rate limit and server errors', () => {
    expect(shouldRetryProxyRequest(429, 'rate limit')).toBe(true);
    expect(shouldRetryProxyRequest(500, 'internal error')).toBe(true);
    expect(shouldRetryProxyRequest(503, 'service unavailable')).toBe(true);
  });

  it('retries on model unsupported messages from upstream', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":"当前 API 不支持所选模型 claude-sonnet-4-5-20250929","type":"error"}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"unsupported model: claude-3"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"The model `gpt-4.1` does not exist"}}'),
    ).toBe(true);
  });

  it('does not retry obvious request-shape errors that will fail on every channel', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"invalid request body"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(422, '{"error":{"message":"unprocessable"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(404, '{"error":{"message":"not found"}}'),
    ).toBe(false);
  });

  it('keeps retrying channel-local compatibility and auth failures', () => {
    expect(
      shouldRetryProxyRequest(401, '{"error":{"message":"invalid access token"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(403, '{"error":{"message":"forbidden"}}'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(403, 'Your request was blocked.'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(403, 'access denied'),
    ).toBe(true);
    expect(
      shouldRetryProxyRequest(400, 'Unsupported legacy protocol: /v1/chat/completions is not supported. Please use /v1/responses.'),
    ).toBe(true);
  });

  it('does not failover on codex-only protocol policy errors', () => {
    const payload = JSON.stringify({
      error: {
        code: 'codex_requires_responses_protocol',
        message: 'codex clients may only use the OpenAI Responses protocol at /v1/responses',
        type: 'policy_violation',
      },
    });
    expect(isNonRetryableProtocolPolicyError(payload)).toBe(true);
    expect(shouldRetryProxyRequest(403, payload)).toBe(false);
  });

  it('does not retry or cascade NewAPI sensitive-word policy rejections reported as 500', () => {
    const payload = JSON.stringify({
      error: {
        code: 'sensitive_words_detected',
        message: 'sensitive words detected',
      },
    });
    expect(isNonRetryableProtocolPolicyError(payload)).toBe(true);
    expect(shouldRetryProxyRequest(500, payload)).toBe(false);
    expect(shouldAbortSameSiteEndpointFallback(500, payload)).toBe(true);
  });

  it('does not retry client-side timeout validation errors', () => {
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"timeout must be <= 60"}}'),
    ).toBe(false);
    expect(
      shouldRetryProxyRequest(400, '{"error":{"message":"invalid timeout parameter"}}'),
    ).toBe(false);
  });

  it('aborts same-site endpoint fallback on rate-limit and quota responses', () => {
    expect(
      shouldAbortSameSiteEndpointFallback(429, '{"error":{"message":"rate limit exceeded"}}'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(429, '{"error":{"message":"quota exceeded"}}'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(429, '{"error":{"message":"too many requests"}}'),
    ).toBe(true);
  });

  it('aborts same-site protocol cascade on relay 502/503/504/524 failures', () => {
    expect(shouldAbortSameSiteEndpointFallback(502, 'openai_error')).toBe(true);
    expect(shouldAbortSameSiteEndpointFallback(503, 'system cpu overloaded')).toBe(true);
    expect(shouldAbortSameSiteEndpointFallback(504, 'Cloudflare Gateway time-out')).toBe(true);
    expect(shouldAbortSameSiteEndpointFallback(524, 'A timeout occurred')).toBe(true);
  });

  it('keeps same-site cascade when NewAPI reports no available channel on one protocol path', () => {
    const body = JSON.stringify({
      error: {
        code: 'model_not_found',
        message: 'No available channel for model claude-opus-4-6 under group claude (distributor)',
        type: 'new_api_error',
      },
    });
    // messages-first probe hits 503 here, but chat/completions can still 200.
    expect(shouldAbortSameSiteEndpointFallback(503, body)).toBe(false);
    expect(shouldAbortSameSiteEndpointFallback(503, '无可用渠道')).toBe(false);
    // Real site overload still aborts.
    expect(shouldAbortSameSiteEndpointFallback(503, 'system cpu overloaded')).toBe(true);
  });

  it('aborts same-site protocol cascade on WAF blocks but keeps generic forbidden eligible for protocol recovery', () => {
    expect(shouldAbortSameSiteEndpointFallback(403, 'Your request was blocked.')).toBe(true);
    expect(shouldAbortSameSiteEndpointFallback(403, 'error code: 1010')).toBe(true);
    expect(shouldAbortSameSiteEndpointFallback(403, 'forbidden')).toBe(false);
  });

  it('aborts same-site protocol cascade when model/tool/function is missing', () => {
    expect(
      shouldAbortSameSiteEndpointFallback(
        404,
        "Function id '74f02205-c7ba-438f-b81a-2537955bd7ec' version 'null': Specified function in account is not found",
      ),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(404, 'unknown provider for model gpt-5.4'),
    ).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(404, 'The model `gpt-4.1` does not exist'),
    ).toBe(true);
    // Generic path Not Found still allows endpoint recovery.
    expect(shouldAbortSameSiteEndpointFallback(404, 'Not Found')).toBe(false);
  });

  it('aborts same-site cascade on ambiguous openai_error but still retries other channels', () => {
    expect(shouldAbortSameSiteEndpointFallback(400, 'openai_error')).toBe(true);
    expect(shouldRetryProxyRequest(400, 'openai_error')).toBe(true);
    expect(
      shouldAbortSameSiteEndpointFallback(400, 'failed to deserialize the provided data'),
    ).toBe(true);
  });

  it('aborts same-site cascade and retries other channels on first-byte timeout', () => {
    expect(shouldAbortSameSiteEndpointFallback(408, 'first byte timeout')).toBe(true);
    expect(shouldRetryProxyRequest(408, 'first byte timeout')).toBe(true);
  });

  it('classifies transient-recovering failures for failover backoff', () => {
    // WAF / edge 403 blocks recover within seconds.
    expect(isRecoveringTransientFailure(403, 'Your request was blocked.')).toBe(true);
    expect(isRecoveringTransientFailure(403, 'error code: 1010')).toBe(true);
    // Bare forbidden 403 is treated as temporarily recoverable.
    expect(isRecoveringTransientFailure(403, 'forbidden')).toBe(true);
    expect(isRecoveringTransientFailure(403, 'Forbidden')).toBe(true);
    // Rate limits and 5xx are self-healing.
    expect(isRecoveringTransientFailure(429, 'rate limit exceeded')).toBe(true);
    expect(isRecoveringTransientFailure(503, 'service unavailable')).toBe(true);
    expect(isRecoveringTransientFailure(502, 'bad gateway')).toBe(true);
    // Credential death / request-shape errors will not self-heal.
    expect(isRecoveringTransientFailure(401, 'invalid access token')).toBe(false);
    expect(isRecoveringTransientFailure(400, 'invalid request body')).toBe(false);
    expect(isRecoveringTransientFailure(422, 'unprocessable')).toBe(false);
    // Site/organization-level credential death is never recovering.
    expect(isRecoveringTransientFailure(403, 'This organization has been disabled.')).toBe(false);
    expect(isRecoveringTransientFailure(403, 'Your access was terminated')).toBe(false);
    expect(isRecoveringTransientFailure(401, 'This account has been deactivated.')).toBe(false);
  });

  it('returns zero backoff when disabled or not a recovering failure', () => {
    expect(resolveFailoverBackoffMs(403, 'forbidden', 0)).toBe(0);
    expect(resolveFailoverBackoffMs(403, 'forbidden', 800)).toBe(800);
    expect(resolveFailoverBackoffMs(401, 'invalid access token', 800)).toBe(0);
    expect(resolveFailoverBackoffMs(200, null, 800)).toBe(0);
  });

  it('allows exactly one in-place retry for recovering failures on the first attempt', () => {
    // First attempt + recovering failure + backoff enabled → in-place retry allowed.
    expect(canRetryInPlaceForRecoveringFailure(0, 403, 'forbidden', 800)).toBe(true);
    expect(canRetryInPlaceForRecoveringFailure(0, 429, 'rate limit', 800)).toBe(true);
    expect(canRetryInPlaceForRecoveringFailure(0, 503, 'unavailable', 800)).toBe(true);
    // Never on later attempts (prevents infinite loops).
    expect(canRetryInPlaceForRecoveringFailure(1, 403, 'forbidden', 800)).toBe(false);
    expect(canRetryInPlaceForRecoveringFailure(2, 403, 'forbidden', 800)).toBe(false);
    // Not for credential death / request-shape errors.
    expect(canRetryInPlaceForRecoveringFailure(0, 401, 'invalid access token', 800)).toBe(false);
    expect(canRetryInPlaceForRecoveringFailure(0, 400, 'invalid request body', 800)).toBe(false);
    // Backoff disabled → never.
    expect(canRetryInPlaceForRecoveringFailure(0, 403, 'forbidden', 0)).toBe(false);
  });

  it('stays on the same channel during the grace window for recovering failures', () => {
    // Within the grace window + recovering failure → grace retry allowed.
    expect(shouldGraceRetryInPlace(0, 8000, 403, 'forbidden')).toBe(true);
    expect(shouldGraceRetryInPlace(1000, 8000, 429, 'rate limit')).toBe(true);
    expect(shouldGraceRetryInPlace(7999, 8000, 503, 'unavailable')).toBe(true);
    // Grace window expired → failover engages.
    expect(shouldGraceRetryInPlace(8000, 8000, 403, 'forbidden')).toBe(false);
    expect(shouldGraceRetryInPlace(9000, 8000, 403, 'forbidden')).toBe(false);
    // Feature disabled (graceMs = 0) → never.
    expect(shouldGraceRetryInPlace(0, 0, 403, 'forbidden')).toBe(false);
    // Non-recovering failures never grace-retry.
    expect(shouldGraceRetryInPlace(0, 8000, 401, 'invalid access token')).toBe(false);
    expect(shouldGraceRetryInPlace(0, 8000, 400, 'invalid request body')).toBe(false);
    // Invalid elapsed time → never.
    expect(shouldGraceRetryInPlace(-1, 8000, 403, 'forbidden')).toBe(false);
    expect(shouldGraceRetryInPlace(Number.NaN, 8000, 403, 'forbidden')).toBe(false);
  });

  it('allows at most one grace-window in-place retry per request', () => {
    // First recovering failure inside the window → allowed.
    expect(shouldGraceRetryInPlaceOnce(false, 1000, 8000, 403, 'forbidden')).toBe(true);
    expect(shouldGraceRetryInPlaceOnce(false, 1000, 8000, 429, 'rate limit')).toBe(true);
    expect(shouldGraceRetryInPlaceOnce(false, 1000, 8000, 503, 'unavailable')).toBe(true);
    // Second failure (already grace-retried) → NOT allowed, even inside window:
    // a block that survived the first grace retry is unlikely to clear within
    // the same window, so we hand off to multi-channel failover.
    expect(shouldGraceRetryInPlaceOnce(true, 1000, 8000, 403, 'forbidden')).toBe(false);
    expect(shouldGraceRetryInPlaceOnce(true, 1000, 8000, 429, 'rate limit')).toBe(false);
    expect(shouldGraceRetryInPlaceOnce(true, 1000, 8000, 503, 'unavailable')).toBe(false);
    // Window expired → never, even without a prior grace retry.
    expect(shouldGraceRetryInPlaceOnce(false, 9000, 8000, 403, 'forbidden')).toBe(false);
    // Feature disabled → never.
    expect(shouldGraceRetryInPlaceOnce(false, 0, 0, 403, 'forbidden')).toBe(false);
    // Non-recovering failure → never.
    expect(shouldGraceRetryInPlaceOnce(false, 1000, 8000, 401, 'invalid access token')).toBe(false);
  });
});
