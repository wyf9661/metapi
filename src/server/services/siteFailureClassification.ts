/**
 * Shared site/upstream failure classification vocabulary.
 *
 * Extracted from tokenRouter.ts so retry classification and routing-health
 * classification can share one failure vocabulary (see AGENTS.md: "Retry
 * classification and routing health classification should share the same
 * failure vocabulary whenever possible"). These are pure functions with no
 * module state — safe to import from routing, retry, and health code.
 *
 * Also owns the proxy failover taxonomy used by endpoint cascade and channel
 * retry so those policies do not diverge.
 */

export type SiteRuntimeFailureContext = {
  status?: number | null;
  errorText?: string | null;
  modelName?: string | null;
};

/** Timeout / first-byte patterns shared by retry and site health. */
export const RETRYABLE_TIMEOUT_PATTERNS: RegExp[] = [
  /(request timed out|connection timed out|read timeout|first byte timeout|\btimed out\b)/i,
];

/**
 * Unified failure classes for cascade / channel failover / cooldown.
 * Prefer this over ad-hoc status checks at call sites.
 */
export type ProxyFailureClass =
  | 'transient_upstream'
  | 'timeout'
  | 'waf_blocked'
  | 'rate_limit'
  | 'quota_or_credit'
  | 'auth_channel'
  | 'model_unsupported'
  | 'protocol_hint'
  | 'protocol_policy'
  | 'request_validation'
  | 'ambiguous_client'
  | 'endpoint_pool_down'
  | 'unknown';

export type ProxyFailureDecision = {
  class: ProxyFailureClass;
  /** Switch to another channel (multi-site failover). */
  retryChannel: boolean;
  /** Continue same-site endpoint cascade (chat/messages/responses). */
  cascadeEndpoint: boolean;
  /** Soft multiplier for channel cooldown length (1 = baseline). */
  cooldownWeight: number;
  /** Scope hint for cooldown / health bookkeeping. */
  cooldownScope: 'channel' | 'channel_model' | 'endpoint' | 'credential' | 'site' | 'none';
};

const QUOTA_OR_CREDIT_PATTERNS: RegExp[] = [
  /run\s+out\s+of\s+credits/i,
  /insufficient\s+(?:quota|balance|credit)/i,
  /预扣费额度失败/i,
  /用户剩余额度/i,
  /余额不足/i,
  /quota\s+exceeded/i,
  /no\s+available\s+quota/i,
];

const AUTH_CHANNEL_PATTERNS: RegExp[] = [
  /invalid\s+api\s+key/i,
  /invalid\s+access\s+token/i,
  /unauthorized/i,
  /authentication/i,
  /token\s+expired/i,
  /access\s+token.*expired/i,
];

const AMBIGUOUS_CLIENT_PATTERNS: RegExp[] = [
  /\bopenai_error\b/i,
  /failed\s+to\s+deserialize/i,
  /data\s+did\s+not\s+match\s+any\s+variant/i,
  /not\s+available\s*\(request\s+id/i,
];

const PROTOCOL_POLICY_PATTERNS: RegExp[] = [
  /codex_requires_responses_protocol/i,
  /codex clients may only use the openai responses protocol/i,
  /only use the openai responses protocol/i,
  /policy_violation/i,
  /sensitive[_\s-]*words?[_\s-]*detected/i,
  /敏感词(?:检测|拦截|命中)/i,
];

const PROTOCOL_LOCAL_CHANNEL_UNAVAILABLE_PATTERNS: RegExp[] = [
  /no\s+available\s+channel/i,
  /分组下.*无可用渠道/i,
  /无可用渠道/i,
];

const ENDPOINT_POOL_DOWN_PATTERNS: RegExp[] = [
  /API\s*请求地址均不可用/i,
  /endpoint\s+pool\s+exhausted/i,
  /all\s+(?:api\s+)?endpoints?\s+(?:are\s+)?unavailable/i,
];

export const SITE_PROTOCOL_FAILURE_PATTERNS: RegExp[] = [
  /unsupported\s+legacy\s+protocol/i,
  /please\s+use\s+\/v1\/responses/i,
  /please\s+use\s+\/v1\/messages/i,
  /please\s+use\s+\/v1\/chat\/completions/i,
  /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i,
  /unsupported\s+endpoint/i,
  /unsupported\s+path/i,
  /unknown\s+endpoint/i,
  /unrecognized\s+request\s+url/i,
  /no\s+route\s+matched/i,
];

export const SITE_MODEL_FAILURE_PATTERNS: RegExp[] = [
  /unsupported\s+model/i,
  /model\s+not\s+supported/i,
  /does\s+not\s+support(?:\s+the)?\s+model/i,
  /no\s+such\s+model/i,
  /unknown\s+model/i,
  /unknown\s+provider\s+for\s+model/i,
  /invalid\s+model/i,
  /model.*does\s+not\s+exist/i,
  /当前\s*api\s*不支持所选模型/i,
  /不支持所选模型/i,
];

export const SITE_VALIDATION_FAILURE_PATTERNS: RegExp[] = [
  /invalid\s+request\s+body/i,
  /validation/i,
  /missing\s+required/i,
  /required\s+parameter/i,
  /unknown\s+parameter/i,
  /unrecognized\s+(field|key|parameter)/i,
  /malformed/i,
  /invalid\s+json/i,
  /cannot\s+parse/i,
  /unsupported\s+media\s+type/i,
  /sensitive[_\s-]*words?[_\s-]*detected/i,
  /敏感词(?:检测|拦截|命中)/i,
];

export const SITE_TRANSIENT_FAILURE_PATTERNS: RegExp[] = [
  /bad\s+gateway/i,
  /gateway\s+time-?out/i,
  ...RETRYABLE_TIMEOUT_PATTERNS,
  /service\s+unavailable/i,
  /temporar(?:y|ily)\s+unavailable/i,
  /cpu\s+overloaded/i,
  /overloaded/i,
  /connection\s+reset/i,
  /connection\s+refused/i,
  /econnreset/i,
  /econnrefused/i,
  // Site multi-base-url pool exhausted — treat as site-wide transient outage.
  /API\s*请求地址均不可用/i,
  /endpoint\s+pool\s+exhausted/i,
  /all\s+(?:api\s+)?endpoints?\s+(?:are\s+)?unavailable/i,
];

/** Cloudflare / edge WAF blocks — short model-scoped cooldown, not permanent auth failure. */
export const SITE_WAF_BLOCK_FAILURE_PATTERNS: RegExp[] = [
  /your\s+request\s+was\s+blocked/i,
  /error\s+code:\s*1010/i,
  /cf-ray/i,
  /access\s+denied.*cloudflare/i,
  /attention\s+required.*cloudflare/i,
];

export const USAGE_LIMIT_RATE_LIMIT_PATTERNS: RegExp[] = [
  /usage_limit_reached/i,
  /usage\s+limit\s+has\s+been\s+reached/i,
  /quota\s+exceeded/i,
  /rate\s+limit/i,
  /\blimit\b/i,
];

export function matchesAnyPattern(patterns: RegExp[], input?: string | null): boolean {
  const text = (input || '').trim();
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

export function isUsageLimitRateLimitFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  if (status !== 429) return false;
  return matchesAnyPattern(USAGE_LIMIT_RATE_LIMIT_PATTERNS, context.errorText);
}

export function isModelScopedRuntimeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return matchesAnyPattern(SITE_MODEL_FAILURE_PATTERNS, context.errorText);
}

export function isProtocolRuntimeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return matchesAnyPattern(SITE_PROTOCOL_FAILURE_PATTERNS, context.errorText);
}

export function isValidationRuntimeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return matchesAnyPattern(SITE_VALIDATION_FAILURE_PATTERNS, context.errorText);
}

/**
 * Edge / Cloudflare WAF blocks. These are often model- or path-scoped and recover
 * within minutes; treat them as short cooldowns rather than permanent 403 auth fails.
 */
export function isWafBlockedRuntimeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  if (!errorText) return false;
  // Prefer explicit WAF vocabulary; status is usually 403 but some proxies rewrite it.
  if (!matchesAnyPattern(SITE_WAF_BLOCK_FAILURE_PATTERNS, errorText)) {
    return false;
  }
  if (status === 0 || status === 403 || status === 401 || status >= 500) {
    return true;
  }
  return status >= 400 && status < 500;
}

/**
 * Penalty weight applied to a site's runtime health score for a given failure.
 * Higher = worse (site gets down-ranked more).
 */
export function resolveSiteRuntimeFailurePenalty(context: SiteRuntimeFailureContext = {}): number {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();

  if (isUsageLimitRateLimitFailure({ status, errorText })) {
    return 0.4;
  }

  if (isModelScopedRuntimeFailure({ status, errorText })) {
    return 0.9;
  }

  if (isProtocolRuntimeFailure({ status, errorText })) {
    return 0.6;
  }

  if (isValidationRuntimeFailure({ status, errorText })) {
    return 0.25;
  }

  // Dead endpoint pool is a site-wide outage signal: score like a hard 5xx so
  // three quick hits open the short breaker and stop burning failover budget.
  if (
    /API\s*请求地址均不可用/i.test(errorText)
    || /endpoint\s+pool\s+exhausted/i.test(errorText)
    || /all\s+(?:api\s+)?endpoints?\s+(?:are\s+)?unavailable/i.test(errorText)
  ) {
    return 3.0;
  }

  // WAF blocks should rank high enough to open a model-scoped breaker quickly,
  // but stay below hard 5xx so genuine gateway outages still outrank them.
  if (isWafBlockedRuntimeFailure({ status, errorText })) {
    return 2.4;
  }

  if (status >= 500 || matchesAnyPattern(SITE_TRANSIENT_FAILURE_PATTERNS, errorText)) {
    return 2.5;
  }

  if (status === 429) {
    return 2.2;
  }

  if (status === 401 || status === 403) {
    return 1.8;
  }

  if (status >= 400 && status < 500) {
    return 0.9;
  }

  return 1.2;
}

/**
 * Whether a failure is transient (worth a short cooldown / breaker) vs a hard
 * failure (model/protocol/validation errors that will keep failing).
 */
export function isTransientSiteRuntimeFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  if (isUsageLimitRateLimitFailure({ status, errorText })) {
    return false;
  }
  if (isModelScopedRuntimeFailure({ status, errorText })) {
    return false;
  }
  if (isProtocolRuntimeFailure({ status, errorText })) {
    return false;
  }
  if (isValidationRuntimeFailure({ status, errorText })) {
    return false;
  }
  // WAF 403 is temporary edge filtering — count toward the short model breaker.
  if (isWafBlockedRuntimeFailure({ status, errorText })) {
    return true;
  }
  if (matchesAnyPattern(SITE_TRANSIENT_FAILURE_PATTERNS, errorText)) {
    return true;
  }
  return status >= 500 || status === 429;
}

function isTimeoutFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  if (status === 408) return true;
  return matchesAnyPattern(RETRYABLE_TIMEOUT_PATTERNS, context.errorText);
}

function isQuotaOrCreditFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  if (status === 402) return true;
  return matchesAnyPattern(QUOTA_OR_CREDIT_PATTERNS, context.errorText);
}

function isAuthChannelFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  if (status !== 401 && status !== 403) return false;
  if (isWafBlockedRuntimeFailure(context)) return false;
  if (isQuotaOrCreditFailure(context)) return false;
  // Bare "forbidden" is often path/protocol rejection, not credential death.
  // Leave it for the protocol-hint branch so same-site cascade can still help.
  const text = (context.errorText || '').trim();
  if (status === 403 && /^\s*forbidden\s*\.?$/i.test(text)) {
    return false;
  }
  return matchesAnyPattern(AUTH_CHANNEL_PATTERNS, context.errorText)
    || matchesAnyPattern([/access\s+denied/i], context.errorText)
    || !(context.errorText || '').trim();
}

function isProtocolPolicyFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return matchesAnyPattern(PROTOCOL_POLICY_PATTERNS, context.errorText);
}

function isProtocolLocalCapacityFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  if (status !== 503) return false;
  return matchesAnyPattern(PROTOCOL_LOCAL_CHANNEL_UNAVAILABLE_PATTERNS, context.errorText);
}

function isEndpointPoolDownFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return matchesAnyPattern(ENDPOINT_POOL_DOWN_PATTERNS, context.errorText);
}

function isAmbiguousClientFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  if (status !== 400 && status !== 404 && status !== 422) return false;
  if (isModelScopedRuntimeFailure(context)) return false;
  if (isProtocolRuntimeFailure(context)) return false;
  if (isValidationRuntimeFailure(context)) return false;
  if (isProtocolPolicyFailure(context)) return false;
  // Only treat known-fuzzy upstream bodies as ambiguous. Generic 400/422 stay
  // non-retryable so client-shape errors do not burn the failover budget.
  return matchesAnyPattern(AMBIGUOUS_CLIENT_PATTERNS, context.errorText);
}

/**
 * Single taxonomy for proxy cascade / channel failover / cooldown decisions.
 */
export function classifyProxyFailure(context: SiteRuntimeFailureContext = {}): ProxyFailureDecision {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  const ctx = { status, errorText, modelName: context.modelName };

  if (isProtocolPolicyFailure(ctx)) {
    return {
      class: 'protocol_policy',
      retryChannel: false,
      cascadeEndpoint: false,
      cooldownWeight: 0.2,
      cooldownScope: 'none',
    };
  }

  if (isEndpointPoolDownFailure(ctx)) {
    return {
      class: 'endpoint_pool_down',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 2.5,
      cooldownScope: 'site',
    };
  }

  if (isTimeoutFailure(ctx)) {
    return {
      class: 'timeout',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 1.4,
      cooldownScope: 'channel_model',
    };
  }

  if (isWafBlockedRuntimeFailure(ctx)) {
    return {
      class: 'waf_blocked',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 2.0,
      // Cloudflare/edge WAF blocks the whole site (bot detection, path
      // rules), not a single endpoint. Scope the cooldown to the site so
      // every model/channel on that site stops hitting it until the block
      // clears, instead of each channel-model pair burning one request.
      cooldownScope: 'site',
    };
  }

  if (isUsageLimitRateLimitFailure(ctx) || status === 429) {
    return {
      class: 'rate_limit',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 1.8,
      cooldownScope: 'credential',
    };
  }

  if (isQuotaOrCreditFailure(ctx)) {
    return {
      class: 'quota_or_credit',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 2.2,
      cooldownScope: 'credential',
    };
  }

  if (isModelScopedRuntimeFailure(ctx)) {
    return {
      class: 'model_unsupported',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 1.6,
      cooldownScope: 'channel_model',
    };
  }

  // Explicit "please use /v1/xxx" — same-site protocol recovery is useful.
  if (isProtocolRuntimeFailure(ctx)) {
    return {
      class: 'protocol_hint',
      retryChannel: true,
      cascadeEndpoint: true,
      cooldownWeight: 0.8,
      cooldownScope: 'endpoint',
    };
  }

  // NewAPI path-local "no available channel" may still succeed on another protocol.
  if (isProtocolLocalCapacityFailure(ctx)) {
    return {
      class: 'transient_upstream',
      retryChannel: true,
      cascadeEndpoint: true,
      cooldownWeight: 1.0,
      cooldownScope: 'endpoint',
    };
  }

  if (isValidationRuntimeFailure(ctx)) {
    return {
      class: 'request_validation',
      retryChannel: false,
      cascadeEndpoint: false,
      cooldownWeight: 0.1,
      cooldownScope: 'none',
    };
  }

  if (isAuthChannelFailure(ctx)) {
    return {
      class: 'auth_channel',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 1.5,
      cooldownScope: 'credential',
    };
  }

  if (status >= 500 || matchesAnyPattern(SITE_TRANSIENT_FAILURE_PATTERNS, errorText)) {
    return {
      class: 'transient_upstream',
      retryChannel: true,
      // 5xx is site/origin health, not protocol recovery material.
      cascadeEndpoint: false,
      cooldownWeight: 1.8,
      cooldownScope: 'channel',
    };
  }

  if (isAmbiguousClientFailure(ctx)) {
    return {
      class: 'ambiguous_client',
      // Another channel may accept the same body; same-site protocol thrash rarely helps.
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 1.2,
      cooldownScope: 'channel_model',
    };
  }

  // A bare 403/404 often means the selected path is wrong rather than that the
  // channel is dead. Preserve one same-site protocol recovery attempt; explicit
  // WAF/auth/model/protocol errors already returned above with stricter policy.
  if (status === 403 && /\bforbidden\b/i.test(errorText)) {
    return {
      class: 'protocol_hint',
      retryChannel: true,
      cascadeEndpoint: true,
      cooldownWeight: 0.8,
      cooldownScope: 'endpoint',
    };
  }
  if (status === 404 && /^\s*not found\s*$/i.test(errorText)) {
    return {
      class: 'unknown',
      retryChannel: false,
      cascadeEndpoint: true,
      cooldownWeight: 0.2,
      cooldownScope: 'none',
    };
  }

  // Generic client errors: do not burn multi-channel or multi-endpoint budget.
  if (status === 400 || status === 404 || status === 422) {
    return {
      class: 'request_validation',
      retryChannel: false,
      cascadeEndpoint: false,
      cooldownWeight: 0.2,
      cooldownScope: 'none',
    };
  }

  if (status === 401 || status === 403) {
    return {
      class: 'auth_channel',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 1.3,
      cooldownScope: 'credential',
    };
  }

  if (status === 409 || status === 425) {
    return {
      class: 'transient_upstream',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 1.0,
      cooldownScope: 'channel',
    };
  }

  return {
    class: 'unknown',
    retryChannel: status >= 500 || status === 0,
    cascadeEndpoint: false,
    cooldownWeight: 1.0,
    cooldownScope: status >= 400 ? 'channel' : 'none',
  };
}

/** Whether multi-channel failover is worthwhile for this failure. */
export function shouldRetryChannelForFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return classifyProxyFailure(context).retryChannel;
}

/**
 * Whether remaining same-site endpoints should be abandoned after this failure.
 * true = stop cascade and leave the site.
 */
export function shouldAbortSameSiteEndpointForFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return !classifyProxyFailure(context).cascadeEndpoint;
}

/**
 * Failover stop signal: consecutive failures of these classes rarely improve by
 * burning more channels (still allow one switch; stop after repeated hits).
 * Includes high-cost operational failures (timeout/5xx) observed in live traces.
 */
export function isLowValueFailoverFailureClass(failureClass: ProxyFailureClass): boolean {
  return failureClass === 'waf_blocked'
    || failureClass === 'model_unsupported'
    || failureClass === 'quota_or_credit'
    || failureClass === 'endpoint_pool_down'
    || failureClass === 'ambiguous_client'
    || failureClass === 'timeout'
    || failureClass === 'transient_upstream';
}

/**
 * Same-request site short-circuit: after these failures, other channels on the
 * same site are unlikely to help and should be excluded for the rest of the request.
 */
export function shouldExcludeSiteForRequestFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const decision = classifyProxyFailure(context);
  return decision.class === 'waf_blocked'
    || decision.class === 'timeout'
    || decision.class === 'transient_upstream'
    || decision.class === 'endpoint_pool_down'
    || decision.class === 'rate_limit'
    || decision.class === 'quota_or_credit';
}
