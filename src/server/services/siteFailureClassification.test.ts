import { describe, expect, it } from 'vitest';
import {
  isModelScopedRuntimeFailure,
  isProtocolRuntimeFailure,
  isCredentialInvalidFailure,
  isTransientSiteRuntimeFailure,
  isUsageLimitRateLimitFailure,
  isValidationRuntimeFailure,
  isWafBlockedRuntimeFailure,
  matchesAnyPattern,
  resolveSiteRuntimeFailurePenalty,
  SITE_TRANSIENT_FAILURE_PATTERNS,
  classifyProxyFailure,
  buildProxyFailureDisposition,
  isLowValueFailoverFailureClass,
} from './siteFailureClassification.js';

describe('siteFailureClassification', () => {
  it('builds one disposition for retry and health mutation consumers', () => {
    expect(buildProxyFailureDisposition({
      status: 400,
      errorText: 'invalid request body',
    })).toMatchObject({
      class: 'request_validation',
      retryAction: 'terminal',
      retryChannel: false,
      cooldownScope: 'none',
      incrementFailure: false,
      clearSticky: false,
      clearLastSuccess: false,
    });

    expect(buildProxyFailureDisposition({
      status: 404,
      errorText: 'unsupported model: gpt-5',
    })).toMatchObject({
      class: 'model_unsupported',
      retryAction: 'failover_channel',
      cooldownScope: 'channel_model',
      incrementFailure: true,
      clearSticky: true,
    });

    expect(buildProxyFailureDisposition({
      status: 403,
      errorText: 'This organization has been disabled.',
    })).toMatchObject({
      class: 'credential_invalid',
      retryAction: 'terminal',
      cooldownScope: 'credential',
      incrementFailure: true,
      clearSticky: true,
      clearLastSuccess: true,
    });
  });

  it('classifies local channel capacity as non-health failure', () => {
    expect(buildProxyFailureDisposition({
      status: 503,
      errorText: 'Channel busy: no session slot available',
    })).toMatchObject({
      class: 'local_capacity',
      retryAction: 'failover_channel',
      retryChannel: true,
      cooldownScope: 'none',
      incrementFailure: false,
      clearSticky: false,
      clearLastSuccess: false,
    });
  });

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
    expect(isModelScopedRuntimeFailure({ errorText: 'Model "gpt-5.6-luna" is not supported by any configured account in this group' })).toBe(true);
    expect(isProtocolRuntimeFailure({ errorText: 'please use /v1/responses' })).toBe(true);
    expect(isValidationRuntimeFailure({ errorText: 'invalid request body' })).toBe(true);
  });

  it('classifies group-capacity 404 as model_unsupported with channel_model cooldown', () => {
    const decision = classifyProxyFailure({
      status: 404,
      errorText: 'Model "gpt-5.6-luna" is not supported by any configured account in this group',
    });
    expect(decision.class).toBe('model_unsupported');
    expect(decision.cooldownScope).toBe('channel_model');
    expect(decision.retryChannel).toBe(true);
  });

  it('classifies 410 end-of-life as model_unsupported and failover-eligible', () => {
    const decision = classifyProxyFailure({
      status: 410,
      errorText: "The model 'deepseek-ai/deepseek-v4-flash' has reached its end of life on 2026-08-07T09:00:00Z and is no longer available.",
    });
    expect(decision.class).toBe('model_unsupported');
    expect(decision.cooldownScope).toBe('channel_model');
    expect(decision.retryChannel).toBe(true);

    const bare410 = classifyProxyFailure({ status: 410, errorText: 'gone' });
    expect(bare410.class).not.toBe('model_unsupported');
  });

  it('classifies context overflow 400 as terminal request_validation', () => {
    const decision = classifyProxyFailure({
      status: 400,
      errorText: "This endpoint's maximum context length is 256000 tokens. However, you requested about 256433 tokens.",
    });
    expect(decision.class).toBe('request_validation');
    expect(decision.retryChannel).toBe(false);

    const chinese = classifyProxyFailure({
      status: 400,
      errorText: '上下文长度超出限制',
    });
    expect(chinese.retryChannel).toBe(false);
  });

  it('keeps model-scoped no-channel 503 from cascading protocols', () => {
    const modelScoped = classifyProxyFailure({
      status: 503,
      errorText: 'No available channels for this model',
    });
    expect(modelScoped.retryChannel).toBe(true);
    expect(modelScoped.cascadeEndpoint).toBe(false);

    const pathLocal = classifyProxyFailure({
      status: 503,
      errorText: 'no available channel',
    });
    expect(pathLocal.cascadeEndpoint).toBe(true);
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

  it('isCredentialInvalidFailure detects site-level credential death, not WAF/bare forbidden', () => {
    // Organization disabled → credential_invalid
    expect(isCredentialInvalidFailure({ status: 401, errorText: 'This organization has been disabled.' })).toBe(true);
    expect(isCredentialInvalidFailure({ status: 403, errorText: 'This organization has been restricted.' })).toBe(true);
    // Access terminated / policy violation
    expect(isCredentialInvalidFailure({ status: 403, errorText: 'Your access was terminated due to violation of our policies.' })).toBe(true);
    // Account deactivated / not authorized
    expect(isCredentialInvalidFailure({ status: 403, errorText: 'This account has been deactivated.' })).toBe(true);
    expect(isCredentialInvalidFailure({ status: 403, errorText: 'Your account is not authorized to use this API.' })).toBe(true);
    // Operation not allowed / security token invalid
    expect(isCredentialInvalidFailure({ status: 403, errorText: 'Operation not allowed.' })).toBe(true);
    expect(isCredentialInvalidFailure({ status: 403, errorText: 'The security token included in the request is invalid.' })).toBe(true);
    // 已欠费
    expect(isCredentialInvalidFailure({ status: 403, errorText: '已欠费' })).toBe(true);
    // WAF text → NOT credential_invalid
    expect(isCredentialInvalidFailure({ status: 403, errorText: 'Your request was blocked. CF-RAY: xyz' })).toBe(false);
    // Bare forbidden → NOT credential_invalid (stays protocol_hint)
    expect(isCredentialInvalidFailure({ status: 403, errorText: 'forbidden' })).toBe(false);
    // Key-level auth failure → NOT credential_invalid (stays auth_channel)
    expect(isCredentialInvalidFailure({ status: 401, errorText: 'invalid api key' })).toBe(false);
    // Non-401/403 status → false
    expect(isCredentialInvalidFailure({ status: 500, errorText: 'organization disabled' })).toBe(false);
  });

  it('credential_invalid is not transient, has highest penalty, stops failover', () => {
    const ctx = { status: 403, errorText: 'This organization has been disabled.' };
    expect(isTransientSiteRuntimeFailure(ctx)).toBe(false);
    expect(resolveSiteRuntimeFailurePenalty(ctx)).toBe(3.0);
    const decision = classifyProxyFailure(ctx);
    expect(decision.class).toBe('credential_invalid');
    expect(decision.retryChannel).toBe(false);
    expect(decision.cascadeEndpoint).toBe(false);
    expect(decision.cooldownScope).toBe('credential');
    expect(isLowValueFailoverFailureClass('credential_invalid')).toBe(true);
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
