import { RETRYABLE_TIMEOUT_PATTERNS } from './proxyRetryPolicy.js';

/**
 * Shared site/upstream failure classification vocabulary.
 *
 * Extracted from tokenRouter.ts so retry classification and routing-health
 * classification can share one failure vocabulary (see AGENTS.md: "Retry
 * classification and routing health classification should share the same
 * failure vocabulary whenever possible"). These are pure functions with no
 * module state — safe to import from routing, retry, and health code.
 */

export type SiteRuntimeFailureContext = {
  status?: number | null;
  errorText?: string | null;
  modelName?: string | null;
};

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
