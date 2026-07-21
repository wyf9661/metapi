import { describe, expect, it } from 'vitest';
import {
  isModelScopedRuntimeFailure,
  isProtocolRuntimeFailure,
  isTransientSiteRuntimeFailure,
  isUsageLimitRateLimitFailure,
  isValidationRuntimeFailure,
  matchesAnyPattern,
  resolveSiteRuntimeFailurePenalty,
  SITE_TRANSIENT_FAILURE_PATTERNS,
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
});

  it('treats site endpoint-pool exhaustion as transient with high penalty', () => {
    const ctx = { errorText: '当前站点的 API 请求地址均不可用' };
    expect(isTransientSiteRuntimeFailure(ctx)).toBe(true);
    expect(resolveSiteRuntimeFailurePenalty(ctx)).toBeGreaterThanOrEqual(2.5);
  });

