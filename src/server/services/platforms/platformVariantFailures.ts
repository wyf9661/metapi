/**
 * Diagnose "every credential/endpoint variant failed" paths.
 *
 * Platform adapters try several credential and user-id variants for the same
 * management call and swallow each attempt's error, so a failure leaves only an
 * aggregate "all variants failed" line. A dead session (401), a WAF rejection
 * (403), a moved endpoint (404) and a management timeout are all actionable in
 * different ways, and an 18h production outage (2026-09-28) could not be
 * attributed precisely because those reasons were discarded here.
 *
 * Diagnostics only: nothing in this module influences routing, channel health
 * or retry decisions. Never pass credentials (cookies, tokens, passwords) into
 * `variant` or `reason` — the formatted line is written to logs and events.
 */

export type PlatformVariantFailure = { variant: string; reason: string };

/** How many variant reasons a single log line may name. */
export const MAX_VARIANT_FAILURES_REPORTED = 4;
/** Per-field cap so one verbose upstream body cannot flood a log line. */
export const MAX_VARIANT_REASON_LENGTH = 160;

function truncate(value: string): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_VARIANT_REASON_LENGTH
    ? `${text.slice(0, MAX_VARIANT_REASON_LENGTH)}…`
    : text;
}

/**
 * Compact, credential-free description of one failed attempt.
 *
 * `fetchJson` throws `HTTP <status>: <body>` for non-2xx responses and undici
 * throws a `TimeoutError` when the bounded management signal aborts, so those
 * two cases are named explicitly instead of being flattened into a stack-free
 * `Error`.
 */
export function describeVariantError(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || 'Error';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return truncate(`${name === 'TimeoutError' ? 'timeout' : 'aborted'}: ${error.message || name}`);
    }
    const message = (error.message || '').trim();
    if (!message) return truncate(name);
    return truncate(name === 'Error' ? message : `${name}: ${message}`);
  }
  const text = String(error ?? '').trim();
  return truncate(text || 'unknown failure');
}

/**
 * Reason for an attempt that returned HTTP 2xx but carried nothing usable
 * (success=false, empty list, unexpected shape) — distinct from a transport or
 * status failure, and the case that looks identical to "no error recorded".
 */
export function describeUnusableVariantResponse(detail?: string): string {
  return truncate(detail || 'response had no usable data');
}

/** One-line rendering of the collected variant failures. */
export function formatVariantFailures(failures: PlatformVariantFailure[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const failure of failures) {
    const line = `${truncate(failure.variant)}: ${truncate(failure.reason)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    parts.push(line);
    if (parts.length >= MAX_VARIANT_FAILURES_REPORTED) break;
  }
  if (parts.length === 0) return 'no variant error recorded';
  const omitted = failures.length - parts.length;
  return `${parts.join('; ')}${omitted > 0 ? ` (+${omitted} more)` : ''}`;
}

/** Aggregate warning for a path where every credential/endpoint variant failed. */
export function logAllVariantsFailed(scope: string, failures: PlatformVariantFailure[]): void {
  console.warn(`[new-api] ${scope}: all variants failed (${formatVariantFailures(failures)})`);
}
