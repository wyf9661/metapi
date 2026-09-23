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
import { config } from '../config.js';

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

  it('records a light failure for local channel capacity so the router avoids it', () => {
    // A saturated channel ("Channel busy") must leave a failure mark: with
    // cooldownScope 'none' the router skipped recordFailure entirely, so the
    // very next request picked the same saturated channel again.
    expect(buildProxyFailureDisposition({
      status: 503,
      errorText: 'Channel busy: no session slot available',
    })).toMatchObject({
      class: 'local_capacity',
      retryAction: 'failover_channel',
      retryChannel: true,
      cooldownScope: 'channel_model',
      incrementFailure: true,
      clearSticky: true,
      clearLastSuccess: true,
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

    // Bare 410 (e.g. LittleSheep "Gone") is also failover-eligible: the
    // channel is gone but another site may still serve the model.
    const bare410 = classifyProxyFailure({ status: 410, errorText: 'gone' });
    expect(bare410.class).toBe('model_unsupported');
    expect(bare410.retryChannel).toBe(true);
  });

  it('classifies 413 payload-too-large as failover-eligible with channel cooldown', () => {
    // A body-size cap is channel-local configuration; another channel with a
    // higher limit may accept the same body, so fail over instead of
    // terminating the request.
    const decision = classifyProxyFailure({
      status: 413,
      errorText: 'Upstream returned HTTP 413: 413 Request Entity Too Large',
    });
    expect(decision.retryChannel).toBe(true);
    expect(decision.class).toBe('transient_upstream');
    expect(decision.cooldownScope).toBe('channel');
  });

  it('classifies context overflow as a site-switchable signal when context-aware routing is on', () => {
    const previousMode = config.contextAwareRouting;
    try {
      // Default mode (exclude_known): another site may serve a larger window,
      // so overflow fails over to the next candidate instead of terminating
      // the request. Never counted as a site failure either way.
      config.contextAwareRouting = 'exclude_known';
      const decision = classifyProxyFailure({
        status: 400,
        errorText: "This endpoint's maximum context length is 256000 tokens. However, you requested about 256433 tokens.",
      });
      expect(decision.class).toBe('request_validation');
      expect(decision.retryChannel).toBe(true);
      expect(decision.cooldownScope).toBe('none');

      const chinese = classifyProxyFailure({
        status: 400,
        errorText: '上下文长度超出限制',
      });
      expect(chinese.retryChannel).toBe(true);

      // Legacy fail-fast when the feature is off: without per-site capability
      // data every failover would hit the same rejection.
      config.contextAwareRouting = 'off';
      const legacy = classifyProxyFailure({
        status: 400,
        errorText: '上下文长度超出限制',
      });
      expect(legacy.class).toBe('request_validation');
      expect(legacy.retryChannel).toBe(false);
    } finally {
      config.contextAwareRouting = previousMode;
    }
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

    // The mid-stream idle watchdog reuses the timeout vocabulary so a stalled
    // stream is recorded as a timeout (with channel cooldown) rather than an
    // unclassified transport error.
    const streamIdle = classifyProxyFailure({
      status: 0,
      errorText: 'stream idle timeout (90s)',
    });
    expect(streamIdle.class).toBe('timeout');
    expect(streamIdle.retryChannel).toBe(true);

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

  it('keeps sibling channels usable when one channel answers with empty content', async () => {
    const { shouldExcludeSiteForRequestFailure } = await import('./siteFailureClassification.js');
    // Empty content is a per-channel defect (the relay answers instantly with
    // nothing). Excluding the whole site would drop healthy siblings on the same
    // site, so the failover this failure needs could never happen.
    expect(shouldExcludeSiteForRequestFailure({
      status: 502,
      errorText: 'Upstream returned empty content',
    })).toBe(false);
    // A real origin 5xx still takes the whole site out.
    expect(shouldExcludeSiteForRequestFailure({
      status: 502,
      errorText: 'bad gateway',
    })).toBe(true);
  });

  it('classifies bare transport failures as retryable and low-value', async () => {
    const { classifyProxyFailure, isLowValueFailoverFailureClass } =
      await import('./siteFailureClassification.js');

    // undici's opaque messages must not fall through to 'unknown': that class is
    // not low-value, so a local outage (every outbound connection failing at
    // once) walked the entire candidate pool before giving up.
    for (const errorText of ['fetch failed', 'terminated', 'socket hang up', 'fetch failed (ECONNRESET)']) {
      const decision = classifyProxyFailure({ status: 0, errorText });
      expect(decision.class).toBe('transient_upstream');
      expect(decision.retryChannel).toBe(true);
      expect(isLowValueFailoverFailureClass(decision.class)).toBe(true);
    }
  });

  it('scopes a host-level transport failure to the whole site', async () => {
    const { classifyProxyFailure } = await import('./siteFailureClassification.js');

    // Refused / unresolvable / TLS-broken: broken for every model on that site.
    for (const errorText of [
      'fetch failed (ECONNREFUSED 10.0.0.7:443)',
      'fetch failed (ENOTFOUND api.example.com)',
      'fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
      'fetch failed (UND_ERR_CONNECT_TIMEOUT)',
    ]) {
      expect(classifyProxyFailure({ status: 0, errorText }).cooldownScope).toBe('site');
    }

    // A mid-flight reset is a channel blip, not a site verdict.
    expect(classifyProxyFailure({ status: 0, errorText: 'fetch failed (ECONNRESET)' }).cooldownScope)
      .toBe('channel');
  });

  it('stops the failover cascade after two consecutive transport failures', async () => {
    const { noteFailoverFailureAndShouldStop } = await import('./proxyChannelRetry.js');
    const state = { lowValueStreak: 0, lastClass: null as string | null };

    expect(noteFailoverFailureAndShouldStop(state, 0, 'fetch failed')).toBe(false);
    expect(noteFailoverFailureAndShouldStop(state, 0, 'fetch failed')).toBe(true);
  });
});
