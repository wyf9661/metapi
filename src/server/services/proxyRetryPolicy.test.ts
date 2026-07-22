import { describe, expect, it } from 'vitest';
import {
  isNonRetryableProtocolPolicyError,
  shouldAbortSameSiteEndpointFallback,
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
});
