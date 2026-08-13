import { describe, expect, it } from 'vitest';
import {
  isModelScopedRuntimeFailure,
  isProtocolRuntimeFailure,
  isTransientSiteRuntimeFailure,
  isUsageLimitRateLimitFailure,
  isValidationRuntimeFailure,
  isWafBlockedRuntimeFailure,
  matchesAnyPattern,
  resolveSiteRuntimeFailurePenalty,
  SITE_TRANSIENT_FAILURE_PATTERNS,
  classifyProxyFailure,
  isLowValueFailoverFailureClass,
} from './siteFailureClassification.js';

describe('siteFailureClassification', () => {
  it('matchesAnyPattern handles empty / whitespace input', () => {
    expect(matchesAnyPattern([/x/], '')).toBe(false);
    expect(matchesAnyPattern([/x/], '   ')).toBe(false);
    expect(matchesAnyPattern([/x/], 'axb')).toBe(true);
  });

  it('detects usage-limit rate limit only on 429', () => {
    expect(isUsageLimitRateLimitFailure({ status: 429, errorText: 'quota exceeded' })).toBe(true);
    expect(isUsageLimitRateLimitFailure({ status: 500, errorText: 'quota exceeded' })).toBe(false);
    expect(isUsageLimitRateLimitFailure({ status: 429, errorText: 'random' })).toBe(false);
  });

  it('classifies model / protocol / validation failures', () => {
    expect(isModelScopedRuntimeFailure({ errorText: 'unsupported model' })).toBe(true);
    expect(isModelScopedRuntimeFailure({ errorText: '不支持所选模型' })).toBe(true);
    expect(isProtocolRuntimeFailure({ errorText: 'please use /v1/responses' })).toBe(true);
    expect(isValidationRuntimeFailure({ errorText: 'invalid request body' })).toBe(true);
  });

  it('resolveSiteRuntimeFailurePenalty ranks transient 5xx highest', () => {
    const transient = resolveSiteRuntimeFailurePenalty({ status: 503, errorText: 'service unavailable' });
    const model = resolveSiteRuntimeFailurePenalty({ status: 400, errorText: 'unsupported model' });
    const validation = resolveSiteRuntimeFailurePenalty({ status: 400, errorText: 'invalid json' });
    expect(transient).toBeGreaterThan(model);
    expect(model).toBeGreaterThan(validation);
  });

  it('isTransientSiteRuntimeFailure excludes hard failures', () => {
    expect(isTransientSiteRuntimeFailure({ status: 502, errorText: 'bad gateway' })).toBe(true);
    expect(isTransientSiteRuntimeFailure({ status: 500, errorText: 'unsupported model' })).toBe(false);
    expect(isTransientSiteRuntimeFailure({ status: 429, errorText: 'quota exceeded' })).toBe(false);
    expect(isTransientSiteRuntimeFailure({ status: 400, errorText: 'validation error' })).toBe(false);
  });

  it('transient patterns include retryable timeout vocabulary', () => {
    expect(matchesAnyPattern(SITE_TRANSIENT_FAILURE_PATTERNS, 'ECONNRESET')).toBe(true);
    expect(matchesAnyPattern(SITE_TRANSIENT_FAILURE_PATTERNS, 'overloaded')).toBe(true);
  });

  it('treats site endpoint-pool exhaustion as transient with high penalty', () => {
    const ctx = { errorText: '当前站点的 API 请求地址均不可用' };
    expect(isTransientSiteRuntimeFailure(ctx)).toBe(true);
    expect(resolveSiteRuntimeFailurePenalty(ctx)).toBeGreaterThanOrEqual(2.5);
  });

  it('classifies Cloudflare WAF 403 as transient with high penalty', () => {
    const ctx = { status: 403, errorText: 'Your request was blocked. Error code: 1010. CF-RAY: abc' };
    expect(isWafBlockedRuntimeFailure(ctx)).toBe(true);
    expect(isTransientSiteRuntimeFailure(ctx)).toBe(true);
    expect(resolveSiteRuntimeFailurePenalty(ctx)).toBe(2.4);
    // Plain auth 403 without WAF vocabulary stays non-transient.
    expect(isTransientSiteRuntimeFailure({ status: 403, errorText: 'invalid api key' })).toBe(false);
  });

  it('classifyProxyFailure drives cascade/retry/cooldown consistently', () => {
    const ambiguous = classifyProxyFailure({ status: 400, errorText: 'openai_error' });
    expect(ambiguous.class).toBe('ambiguous_client');
    expect(ambiguous.cascadeEndpoint).toBe(false);
    expect(ambiguous.retryChannel).toBe(true);

    const protocolHint = classifyProxyFailure({
      status: 400,
      errorText: 'Unsupported legacy protocol: please use /v1/responses',
    });
    expect(protocolHint.class).toBe('protocol_hint');
    expect(protocolHint.cascadeEndpoint).toBe(true);

    const timeout = classifyProxyFailure({ status: 408, errorText: 'first byte timeout' });
    expect(timeout.class).toBe('timeout');
    expect(timeout.cascadeEndpoint).toBe(false);
    expect(timeout.retryChannel).toBe(true);

    expect(isLowValueFailoverFailureClass('waf_blocked')).toBe(false);
    expect(isLowValueFailoverFailureClass('timeout')).toBe(true);
    expect(isLowValueFailoverFailureClass('transient_upstream')).toBe(true);
    expect(isLowValueFailoverFailureClass('protocol_hint')).toBe(false);
  });

  it('shouldExcludeSiteForRequestFailure short-circuits operational site failures', async () => {
    const { shouldExcludeSiteForRequestFailure } = await import('./siteFailureClassification.js');
    expect(shouldExcludeSiteForRequestFailure({ status: 408, errorText: 'first byte timeout' })).toBe(true);
    expect(shouldExcludeSiteForRequestFailure({ status: 503, errorText: 'bad gateway' })).toBe(true);
    expect(shouldExcludeSiteForRequestFailure({ status: 403, errorText: 'forbidden' })).toBe(true);
    expect(shouldExcludeSiteForRequestFailure({ status: 403, errorText: 'access denied' })).toBe(true);
    expect(shouldExcludeSiteForRequestFailure({ status: 400, errorText: 'please use /v1/responses' })).toBe(false);
    expect(shouldExcludeSiteForRequestFailure({ status: 400, errorText: 'invalid json' })).toBe(false);
  });
});
