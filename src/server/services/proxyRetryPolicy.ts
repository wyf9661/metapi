const MODEL_UNSUPPORTED_PATTERNS: RegExp[] = [
  /当前\s*api\s*不支持所选模型/i,
  /不支持所选模型/i,
  /不支持.*模型/i,
  /模型.*不支持/i,
  /unsupported\s+model/i,
  /model\s+not\s+supported/i,
  /does\s+not\s+support(?:\s+the)?\s+model/i,
  /model.*does\s+not\s+exist/i,
  /no\s+such\s+model/i,
  /unknown\s+model/i,
  /unknown\s+provider\s+for\s+model/i,
  /invalid\s+model/i,
  /model[_\s-]?not[_\s-]?found/i,
  /you\s+do\s+not\s+have\s+access\s+to\s+the\s+model/i,
];

export const RETRYABLE_TIMEOUT_PATTERNS: RegExp[] = [
  /(request timed out|connection timed out|read timeout|first byte timeout|\btimed out\b)/i,
];

const RETRYABLE_CHANNEL_LOCAL_PATTERNS: RegExp[] = [
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
  /invalid\s+api\s+key/i,
  /invalid\s+access\s+token/i,
  /request\s+was\s+blocked/i,
  /请求已被拦截/i,
  /access\s+denied/i,
  /blocked/i,
  /forbidden/i,
  /rate\s+limit/i,
  /quota/i,
  /bad\s+gateway/i,
  /gateway\s+time-?out/i,
  /service\s+unavailable/i,
  /cpu\s+overloaded/i,
  ...RETRYABLE_TIMEOUT_PATTERNS,
];

const NON_RETRYABLE_REQUEST_PATTERNS: RegExp[] = [
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
];

/**
 * Protocol / policy failures that will not improve by switching channel with the
 * same client request shape (after in-channel endpoint cascade already ran).
 * Fail fast instead of burning the multi-channel retry budget.
 */
const NON_RETRYABLE_PROTOCOL_PATTERNS: RegExp[] = [
  /codex_requires_responses_protocol/i,
  /codex clients may only use the openai responses protocol/i,
  /only use the openai responses protocol/i,
  /policy_violation/i,
];

const SAME_SITE_ENDPOINT_ABORT_PATTERNS: RegExp[] = [
  /\b429\b/i,
  /too\s+many\s+requests/i,
  /rate\s+limit/i,
  /quota(?:\s+exceeded)?/i,
  /bad\s+gateway/i,
  /gateway\s+time-?out/i,
  /service\s+unavailable/i,
  /temporar(?:y|ily)\s+unavailable/i,
  /cpu\s+overloaded/i,
  /connection\s+reset/i,
  /connection\s+refused/i,
  /econnreset/i,
  /econnrefused/i,
  /request\s+was\s+blocked/i,
  /error\s+code:\s*1010/i,
  /cf-ray/i,
  ...RETRYABLE_TIMEOUT_PATTERNS,
];

/**
 * Upstream model/tool/function missing — changing chat/messages/responses on the
 * same site almost never helps. Fail over to another channel immediately.
 */
const SAME_SITE_MODEL_OR_FUNCTION_MISSING_PATTERNS: RegExp[] = [
  /function\s+id\s+['"]?[\w-]+['"]?\s+version/i,
  /function\s+id\s+['"]?[\w-]+['"]?\s+is\s+not\s+found/i,
  /specified\s+function\s+in\s+account/i,
  /unknown\s+provider\s+for\s+model/i,
  /no\s+such\s+model/i,
  /model\s+not\s+found/i,
  /model.*does\s+not\s+exist/i,
  /the\s+model\s+`[^`]+`\s+does\s+not\s+exist/i,
  /模型渠道不存在/i,
  /模型不存在/i,
  /模型未找到/i,
  /渠道不存在/i,
];

function isModelUnsupportedErrorMessage(rawMessage?: string | null): boolean {
  const text = (rawMessage || '').trim();
  if (!text) return false;
  return MODEL_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text));
}

function matchesAnyPattern(patterns: RegExp[], rawMessage?: string | null): boolean {
  const text = (rawMessage || '').trim();
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

export function isNonRetryableProtocolPolicyError(upstreamErrorText?: string | null): boolean {
  return matchesAnyPattern(NON_RETRYABLE_PROTOCOL_PATTERNS, upstreamErrorText);
}

/**
 * Whether failing over to another upstream channel is worthwhile.
 *
 * Retry: 5xx, timeouts, rate limits, channel-local auth, legacy-protocol hints,
 *        model-not-supported (another site may have the model).
 * No retry: request validation, Codex-only policy after conversion path,
 *           generic 4xx that is not channel-local.
 */
export function shouldRetryProxyRequest(status: number, upstreamErrorText?: string | null): boolean {
  // Permanent client/protocol policy — do not burn channel failover budget.
  if (isNonRetryableProtocolPolicyError(upstreamErrorText)) {
    return false;
  }
  if (matchesAnyPattern(NON_RETRYABLE_REQUEST_PATTERNS, upstreamErrorText)) {
    return false;
  }

  if (status >= 500) return true;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;

  // 401/403: only when it looks channel-local (auth / generic forbidden / rate),
  // not blanket-retry every forbidden response.
  if (status === 401 || status === 403) {
    if (matchesAnyPattern(RETRYABLE_CHANNEL_LOCAL_PATTERNS, upstreamErrorText)) return true;
    // Empty body 403 from some edges — allow one failover attempt.
    if (!(upstreamErrorText || '').trim()) return true;
    return false;
  }

  // Multi-site gateway: another channel may still serve this model.
  if (isModelUnsupportedErrorMessage(upstreamErrorText)) return true;

  if (matchesAnyPattern(RETRYABLE_CHANNEL_LOCAL_PATTERNS, upstreamErrorText)) return true;
  if (status === 400 || status === 404 || status === 422) return false;
  return false;
}

export function shouldAbortSameSiteEndpointFallback(status: number, upstreamErrorText?: string | null): boolean {
  // 502/503/504 describe an unhealthy relay/origin, not an endpoint protocol
  // mismatch. Trying chat/messages on the same site only adds latency and can
  // turn an explicit responses-capable site into a misleading protocol chase.
  // 524 is Cloudflare's "origin timeout" — same class as 504, not a protocol mismatch.
  if (status === 502 || status === 503 || status === 504 || status === 524) return true;
  // Model/tool/function missing is not protocol recovery material.
  if (matchesAnyPattern(SAME_SITE_MODEL_OR_FUNCTION_MISSING_PATTERNS, upstreamErrorText)) {
    return true;
  }
  // Cloudflare/WAF blocks are likewise site/request-fingerprint local. Move to
  // another channel rather than cascading through every protocol on this site.
  if ((status === 401 || status === 403) && matchesAnyPattern(SAME_SITE_ENDPOINT_ABORT_PATTERNS, upstreamErrorText)) {
    return true;
  }
  if (status < 500 && status !== 408 && status !== 429) {
    return false;
  }
  return matchesAnyPattern(SAME_SITE_ENDPOINT_ABORT_PATTERNS, upstreamErrorText);
}
