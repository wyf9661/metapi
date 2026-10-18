import {
  parseProxyLogMetadata,
  type ParsedProxyLogMetadata,
  type ProxyLogUsageSource,
} from '../../shared/proxyLogMeta.js';

type ComposeProxyLogMessageArgs = {
  clientKind?: string | null;
  sessionId?: string | null;
  traceHint?: string | null;
  traceId?: string | null;
  downstreamPath?: string | null;
  upstreamPath?: string | null;
  usageSource?: ProxyLogUsageSource;
  errorCode?: string | null;
  errorMessage?: string | null;
  /**
   * Upstream HTTP status observed for this attempt, rendered as a `[status:]`
   * token. Callers pass it only for failed rows (via
   * `proxyLogFailureLocator`), so a success row never grows one.
   */
  upstreamStatus?: number | null;
  /**
   * Site / relay display name this attempt ran on, rendered as a `[site:]`
   * token. Callers pass it only for failed rows (via
   * `proxyLogFailureLocator`), so a success row never grows one.
   */
  siteLabel?: string | null;
};

export type ParsedProxyLogMessageMeta = ParsedProxyLogMetadata;

export function parseProxyLogMessageMeta(rawMessage: string): ParsedProxyLogMessageMeta {
  return parseProxyLogMetadata(rawMessage);
}

/** Keeps a site name inside the `[token:value]` grammar (no brackets, no newlines). */
function normalizeSiteLabel(siteLabel?: string | null): string | null {
  if (typeof siteLabel !== 'string') return null;
  const normalized = siteLabel.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

/** Only a positive, finite HTTP status is worth recording; 0 / null mean "no upstream reply". */
function normalizeUpstreamStatus(upstreamStatus?: number | null): number | null {
  if (typeof upstreamStatus !== 'number' || !Number.isFinite(upstreamStatus)) return null;
  const status = Math.trunc(upstreamStatus);
  return status > 0 ? status : null;
}

/**
 * Locator arguments for a proxy log row, derived from the row status: only a
 * FAILED attempt carries them, so a success row never grows `[site:]` /
 * `[status:]` tokens. This is the whole gate — every failed row that knows its
 * site or upstream status records them, regardless of how descriptive the body
 * already is (a body can name the cause and still not name the site). Unknown
 * site/status stays null, so a locator is never half-true. Spread the result
 * into composeProxyLogMessage.
 */
export function proxyLogFailureLocator(args: {
  status?: string | null;
  siteName?: string | null;
  upstreamStatus?: number | null;
}): { siteLabel: string | null; upstreamStatus: number | null } {
  if (args.status !== 'failed') return { siteLabel: null, upstreamStatus: null };
  return {
    siteLabel: normalizeSiteLabel(args.siteName),
    upstreamStatus: normalizeUpstreamStatus(args.upstreamStatus),
  };
}

export function composeProxyLogMessage({
  clientKind,
  sessionId,
  traceHint,
  traceId,
  downstreamPath,
  upstreamPath,
  usageSource,
  errorCode,
  errorMessage,
  upstreamStatus,
  siteLabel,
}: ComposeProxyLogMessageArgs): string | null {
  const rawMessage = typeof errorMessage === 'string' ? errorMessage.trim() : '';
  const parsed = parseProxyLogMessageMeta(rawMessage);
  // Every token value is attacker-influenced (session ids, paths, codes come
  // from the downstream request): strip brackets and newlines so a value can
  // never smuggle extra `[site:...]`/`[status:...]` tokens into the row.
  const sanitizeTokenValue = (value: string): string => value
    .replace(/[[\]\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const finalClientKind = sanitizeTokenValue(clientKind || parsed.clientKind || '');
  const finalSessionId = sanitizeTokenValue(sessionId || traceHint || parsed.sessionId || '');
  const finalTraceId = sanitizeTokenValue(traceId || parsed.traceId || '');
  const finalDownstreamPath = sanitizeTokenValue(downstreamPath || parsed.downstreamPath || '');
  const finalUpstreamPath = sanitizeTokenValue(upstreamPath || parsed.upstreamPath || '');
  const finalUsageSource = sanitizeTokenValue(usageSource || parsed.usageSource || '');
  const finalErrorCode = sanitizeTokenValue(errorCode || parsed.errorCode || '');
  const finalMessageText = parsed.messageText.trim();
  const locatorSiteLabel = normalizeSiteLabel(siteLabel);
  const locatorUpstreamStatus = normalizeUpstreamStatus(upstreamStatus);

  const prefixParts: string[] = [];
  if (finalClientKind) prefixParts.push(`[client:${finalClientKind}]`);
  if (finalSessionId) prefixParts.push(`[session:${finalSessionId}]`);
  if (finalTraceId) prefixParts.push(`[trace:${finalTraceId}]`);
  if (finalDownstreamPath) prefixParts.push(`[downstream:${finalDownstreamPath}]`);
  if (finalUpstreamPath) prefixParts.push(`[upstream:${finalUpstreamPath}]`);
  if (finalUsageSource) prefixParts.push(`[usage:${finalUsageSource}]`);
  if (finalErrorCode) prefixParts.push(`[code:${finalErrorCode}]`);

  // Locator tokens: appended after the identifying prefixes and before the body
  // on EVERY failed attempt (see proxyLogFailureLocator, the only caller that
  // supplies them). A row then says which site answered and with what upstream
  // status without a DB join — including the rows whose body is a self-explaining
  // upstream `{"error": ...}` or a classification verdict that still never names
  // the site. The body itself is never rewritten: the locator is added around it,
  // never inside it.
  if (locatorSiteLabel !== null) prefixParts.push(`[site:${locatorSiteLabel}]`);
  if (locatorUpstreamStatus !== null) prefixParts.push(`[status:${locatorUpstreamStatus}]`);

  if (prefixParts.length === 0 && !finalMessageText) return null;
  if (finalMessageText) return `${prefixParts.join(' ')} ${finalMessageText}`.trim();
  return prefixParts.join(' ');
}
