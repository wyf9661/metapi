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
  | 'credential_invalid'
  | 'auth_channel'
  | 'model_unsupported'
  | 'protocol_hint'
  | 'protocol_policy'
  | 'request_validation'
  | 'ambiguous_client'
  | 'endpoint_pool_down'
  | 'local_capacity'
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

/** Site/organization-level credential death: the account itself is dead, not
 *  just a particular key or token. Unlike auth_channel (which retries other
 *  channels on the same site), these will never self-heal and should skip
 *  the entire site. */
const CREDENTIAL_INVALID_PATTERNS: RegExp[] = [
  /organization\s+has\s+been\s+(?:disabled|restricted)/i,
  /your\s+access\s+was\s+terminated/i,
  /violation\s+of\s+(?:our\s+)?policies/i,
  /account\s+has\s+been\s+deactivated/i,
  /account\s+is\s+not\s+authorized/i,
  /operation\s+not\s+allowed/i,
  /security\s+token\s+included\s+in\s+the\s+request\s+is\s+invalid/i,
  /已欠费/i,
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
];

/**
 * Site/relay content-moderation rejections (e.g. NewAPI reports these as
 * 500 with code:sensitive_words_detected). Different upstreams apply different
 * keyword rules, so failing over to another channel can legitimately succeed —
 * this is NOT a client-shape error that reproduces on every site.
 */
const SENSITIVE_WORDS_PATTERNS: RegExp[] = [
  /sensitive[\s-]*words?[\s-]*detected/i,
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
  // NewAPI/OneAPI group-capacity wording: "Model \"X\" is not supported by
  // any configured account in this group" — the quoted model name sits
  // between "model" and "not supported", so the plain adjacency pattern
  // above cannot match it.
  /is\s+not\s+supported\s+by\s+any/i,
];

export const SITE_VALIDATION_FAILURE_PATTERNS: RegExp[] = [
  /invalid\s+request\s+body/i,
  /invalid\s+timeout\s+(?:parameter|value)/i,
  /timeout\s+must\s+be\s*(?:<=|less\s+than|greater\s+than|between)/i,
  /validation/i,
  /missing\s+required/i,
  /required\s+parameter/i,
  /unknown\s+parameter/i,
  /unrecognized\s+(field|key|parameter)/i,
  /malformed/i,
  /invalid\s+json/i,
  /cannot\s+parse/i,
  /unsupported\s+media\s+type/i,
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

/**
 * Site content-moderation rejection (NewAPI reports as 500
 * code:sensitive_words_detected). Each upstream applies its own keyword
 * rules, so another channel may accept the same body — classify as
 * retryable instead of a deterministic request-shape error.
 */
export function isSensitiveWordsFailure(context: SiteRuntimeFailureContext = {}): boolean {
  return matchesAnyPattern(SENSITIVE_WORDS_PATTERNS, context.errorText);
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

  // Site/organization credential death is permanent — the highest possible
  // penalty so the site is avoided immediately.
  if (isCredentialInvalidFailure({ status, errorText })) {
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
  // Site/organization credential death is permanent, not transient.
  if (isCredentialInvalidFailure({ status, errorText })) {
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
  if (status >= 400 && status < 500 && isValidationRuntimeFailure(context)) return false;
  return matchesAnyPattern(RETRYABLE_TIMEOUT_PATTERNS, context.errorText);
}

function isQuotaOrCreditFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  if (status === 402) return true;
  return matchesAnyPattern(QUOTA_OR_CREDIT_PATTERNS, context.errorText);
}

/** Site/organization-level credential death: account disabled, access
 *  terminated, policy violation, etc. These failures are permanent on the
 *  site — no amount of key-switching or endpoint-cascading will help. */
export function isCredentialInvalidFailure(context: SiteRuntimeFailureContext = {}): boolean {
  const status = typeof context.status === 'number' ? context.status : 0;
  if (status !== 401 && status !== 403) return false;
  if (isWafBlockedRuntimeFailure(context)) return false;
  return matchesAnyPattern(CREDENTIAL_INVALID_PATTERNS, context.errorText);
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

  if (status === 503 && /Channel busy:|no session slot available|session slot available/i.test(errorText)) {
    return {
      class: 'local_capacity',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 0,
      cooldownScope: 'none',
    };
  }

  if (isProtocolPolicyFailure(ctx)) {
    return {
      class: 'protocol_policy',
      retryChannel: false,
      cascadeEndpoint: false,
      cooldownWeight: 0.2,
      cooldownScope: 'none',
    };
  }

  // Site content-moderation rejection: each upstream has its own keyword
  // rules, so another channel may accept the same body. Fail over instead of
  // terminating (same treatment as model_unsupported — a channel-local
  // rejection that other channels may not reproduce).
  if (isSensitiveWordsFailure(ctx)) {
    return {
      class: 'model_unsupported',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 1.6,
      cooldownScope: 'channel_model',
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

  // Site/organization-level credential death: the account is dead, not just
  // a specific key. Skip the entire site — no key-switching will help.
  if (isCredentialInvalidFailure(ctx)) {
    return {
      class: 'credential_invalid',
      retryChannel: false,
      cascadeEndpoint: false,
      cooldownWeight: 3.0,
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
    const modelScoped = /for\s+this\s+model/i.test(errorText);
    return {
      class: 'transient_upstream',
      retryChannel: true,
      // Model-scoped "no available channels for this model" is a capacity
      // statement about the model itself — switching protocol (chat → messages
      // → responses) on the same site will not conjure channels. Only
      // path-local availability (no protocol qualifier) may benefit from a
      // same-site protocol cascade.
      cascadeEndpoint: !modelScoped,
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
  if (status === 413) {
    // Upstream payload/body-size cap (nginx client_max_body_size or an app
    // limit on that channel) is channel-local configuration: another channel
    // with a higher limit may accept the same body. Fail over instead of
    // terminating (mirrors the 410 treatment).
    return {
      class: 'transient_upstream',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 1.2,
      cooldownScope: 'channel',
    };
  }

  if (status === 410) {
    // Upstream model retired / end-of-life (e.g. OpenAI 410 gone) OR the
    // channel is simply gone (bare "Gone"). Another channel may still serve
    // the model (or a mapped alias), so fail over instead of terminating the
    // request after a single attempt.
    return {
      class: 'model_unsupported',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 1.6,
      cooldownScope: 'channel_model',
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

  // Generic 400: most upstream 400s are worth a channel switch (geo
  // restriction, format mismatch, different proxy handling the body
  // differently). Protocol-policy errors are the exception: retry with
  // the same body on a different channel will produce the same 400.
  if (status === 400) {
    if (isProtocolPolicyFailure(ctx)) {
      return {
        class: 'protocol_policy',
        retryChannel: false,
        cascadeEndpoint: false,
        cooldownWeight: 0.2,
        cooldownScope: 'none',
      };
    }
    // Context overflow is a deterministic request-shape error: the prompt +
    // tool + output budget exceeds the upstream window, so every channel
    // serving the model rejects the same body. Fail fast instead of burning
    // the multi-channel failover budget — the client must trim/compress.
    if (matchesAnyPattern([
      /maximum\s+context\s+length/i,
      /reduce\s+the\s+length/i,
      /context\s+length\s+exceeded/i,
      /too\s+many\s+tokens/i,
      /token\s+limit\s+(?:exceeded|reached)/i,
      /上下文.*(?:超长|过长|超出)/i,
    ], errorText)) {
      return {
        class: 'request_validation',
        retryChannel: false,
        cascadeEndpoint: false,
        cooldownWeight: 0.1,
        cooldownScope: 'none',
      };
    }
    return {
      class: 'request_validation',
      retryChannel: true,
      cascadeEndpoint: false,
      cooldownWeight: 0.1,
      cooldownScope: 'none',
    };
  }
  if (status === 404 || status === 422) {
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

export type ProxyRetryAction =
  | 'retry_same_endpoint'
  | 'cascade_endpoint'
  | 'refresh_auth'
  | 'failover_channel'
  | 'terminal';

export type ProxyFailureDisposition = ProxyFailureDecision & {
  retryAction: ProxyRetryAction;
  incrementFailure: boolean;
  clearSticky: boolean;
  clearLastSuccess: boolean;
};

export function buildProxyFailureDisposition(
  context: SiteRuntimeFailureContext = {},
): ProxyFailureDisposition {
  const status = typeof context.status === 'number' ? context.status : 0;
  const decision = classifyProxyFailure(context);
  const retryAction: ProxyRetryAction = decision.cascadeEndpoint
    ? 'cascade_endpoint'
    : (decision.class === 'auth_channel'
      ? 'refresh_auth'
      : (decision.retryChannel ? 'failover_channel' : 'terminal'));
  const incrementFailure = decision.cooldownScope !== 'none'
    || (status === 0 && retryAction === 'failover_channel');
  const clearSticky = incrementFailure && retryAction !== 'cascade_endpoint';
  const clearLastSuccess = decision.class === 'credential_invalid'
    || (retryAction === 'failover_channel' && incrementFailure);
  return {
    ...decision,
    retryAction,
    incrementFailure,
    clearSticky,
    clearLastSuccess,
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
 * WAF blocks are intentionally excluded: a 403 edge block is site-scoped, so
 * the caller should continue probing other sites rather than stop after two
 * blocked candidates.
 */
export function isLowValueFailoverFailureClass(failureClass: ProxyFailureClass): boolean {
  if (failureClass === 'waf_blocked') return false;
  return failureClass === 'credential_invalid'
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
  if (decision.class === 'waf_blocked'
    || decision.class === 'credential_invalid'
    || decision.class === 'timeout'
    || decision.class === 'transient_upstream'
    || decision.class === 'endpoint_pool_down'
    || decision.class === 'rate_limit'
    || decision.class === 'quota_or_credit'
    || (context.status === 403)) {
    return true;
  }
  return false;
}
