/**
 * Upstream rate-limit hints.
 *
 * Borrowed from magpie's `internal/gateway/routing.go::retryAfter`: when a
 * vendor says how long to wait, believe it instead of guessing. metapi used to
 * apply its own fibonacci backoff to every 429/503, which is wrong in both
 * directions — a vendor that asked for 3s got parked for 30s, and one that
 * asked for 15 minutes got retried 15s later and refused again.
 *
 * Two header families are read:
 *
 *  - `Retry-After` — delta-seconds (float allowed) or an HTTP-date, per
 *    RFC 9110 §10.2.3.
 *  - any header whose lowercased name contains both `ratelimit` and `reset` —
 *    `x-ratelimit-reset-requests`, `anthropic-ratelimit-tokens-reset`, etc.
 *    Their values are vendor-specific, so the common spellings are all tried:
 *    Go-style durations (`6m0s`), bare numbers (seconds, or epoch seconds /
 *    milliseconds when large enough to be one), and RFC 3339 timestamps.
 *
 * Everything is clamped: a hint of 0 or less means "no hint", and anything
 * above the cap is treated as the cap. A vendor asking for a day must not park
 * a channel for a day.
 */

/** The most a vendor's own "try again at" is trusted, per hint. */
export const UPSTREAM_RETRY_HINT_MAX_MS = 60 * 60 * 1000;

/** Epoch seconds at or above this are timestamps, not durations. */
const EPOCH_SECONDS_THRESHOLD = 1_000_000_000;

export type UpstreamRetryHint = {
  /** Clamped wait, or null when the response carried no usable hint. */
  retryAfterMs: number | null;
  /** Which header family produced it; null when there was none. */
  source: 'retry-after' | 'ratelimit-reset' | null;
};

export type HeaderReader = { get(name: string): string | null };

/**
 * Parse a Go-style duration (`1h2m3s`, `250ms`, `1.5s`) into milliseconds.
 * Returns null for anything else, so a bare number is never misread here.
 */
export function parseGoDurationMs(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const pattern = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/g;
  const unitMs: Record<string, number> = {
    h: 3_600_000,
    m: 60_000,
    s: 1_000,
    ms: 1,
    us: 0.001,
    'µs': 0.001,
    ns: 0.000001,
  };
  let total = 0;
  let matched = '';
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    matched += match[0];
    total += Number(match[1]) * (unitMs[match[2] as string] ?? 0);
  }
  // The whole string must be duration segments: "1s or later" is not a duration.
  if (!matched || matched !== text) return null;
  return total;
}

/** RFC 3339 / HTTP-date / epoch (seconds or milliseconds) → wait in ms. */
function parseInstantMs(value: string, nowMs: number): number | null {
  const text = value.trim();
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return null;
    if (numeric >= EPOCH_SECONDS_THRESHOLD) {
      // Heuristic for epoch milliseconds: anything past year 2286 in seconds.
      const epochMs = numeric >= EPOCH_SECONDS_THRESHOLD * 1000 ? numeric : numeric * 1000;
      return epochMs - nowMs;
    }
    // A small bare number is delta-seconds.
    return numeric * 1000;
  }

  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return parsed - nowMs;
  return null;
}

function clampHintMs(waitMs: number | null, maxMs: number): number | null {
  if (waitMs === null || !Number.isFinite(waitMs) || waitMs <= 0) return null;
  return Math.min(Math.trunc(waitMs), maxMs);
}

/** Read one header family; returns the longest usable wait it carries. */
function readHeaderFamily(
  headers: HeaderReader,
  read: (name: string, value: string) => number | null,
  match: (lowerName: string) => boolean,
  maxMs: number,
): number | null {
  let best: number | null = null;
  // undici's Headers supports entries(); a plain record is also accepted by the
  // caller through the adapter in `parseUpstreamRetryHint`.
  const iterable = headers as HeaderReader & { entries?: () => Iterable<[string, string]> };
  if (typeof iterable.entries !== 'function') return null;
  for (const [name, value] of iterable.entries()) {
    const lower = name.toLowerCase();
    if (!match(lower)) continue;
    const wait = clampHintMs(read(lower, value), maxMs);
    if (wait !== null && (best === null || wait > best)) best = wait;
  }
  return best;
}

/**
 * Read the wait an upstream asked for. `maxMs` bounds a single hint; pass 0 to
 * disable the cap.
 */
export function parseUpstreamRetryHint(
  headers: HeaderReader | null | undefined,
  options: { nowMs?: number; maxMs?: number } = {},
): UpstreamRetryHint {
  if (!headers) return { retryAfterMs: null, source: null };
  const nowMs = options.nowMs ?? Date.now();
  const maxMs = Math.max(0, Math.trunc(options.maxMs ?? UPSTREAM_RETRY_HINT_MAX_MS));
  const bound = (value: number | null) => (maxMs > 0 ? clampHintMs(value, maxMs) : clampHintMs(value, Number.MAX_SAFE_INTEGER));

  const retryAfterRaw = headers.get('retry-after');
  if (typeof retryAfterRaw === 'string' && retryAfterRaw.trim()) {
    const text = retryAfterRaw.trim();
    // Delta-seconds first: `Date.parse('120')` would read it as a year.
    const seconds = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : null;
    const wait = bound(seconds ?? parseInstantMs(text, nowMs));
    if (wait !== null) return { retryAfterMs: wait, source: 'retry-after' };
  }

  const resetWait = readHeaderFamily(
    headers,
    (_name, value) => {
      const trimmed = value.trim();
      if (!trimmed) return null;
      // Vendor spellings are tried widest-first: a full duration is unambiguous,
      // a bare number is delta-seconds, a timestamp only when it parses.
      return parseGoDurationMs(trimmed) ?? parseInstantMs(trimmed, nowMs);
    },
    (lower) => lower.includes('ratelimit') && lower.includes('reset'),
    maxMs > 0 ? maxMs : Number.MAX_SAFE_INTEGER,
  );
  if (resetWait !== null) return { retryAfterMs: resetWait, source: 'ratelimit-reset' };

  return { retryAfterMs: null, source: null };
}

/**
 * Combine the local backoff with the upstream's own statement.
 *
 * The upstream wins when it asks for LONGER than the local policy would wait:
 * retrying earlier than the vendor allows is a guaranteed second refusal. It
 * never shortens the local backoff — a hint of "1s" on a channel that has been
 * failing all afternoon must not make the router hammer it once a second.
 */
export function resolveUpstreamInformedCooldownMs(
  localMs: number,
  hintMs: number | null | undefined,
  maxMs = Number.POSITIVE_INFINITY,
): number {
  const local = Number.isFinite(localMs) ? Math.max(0, Math.trunc(localMs)) : 0;
  if (hintMs === null || hintMs === undefined || !Number.isFinite(hintMs) || hintMs <= 0) {
    return Math.min(local, maxMs);
  }
  return Math.min(Math.max(local, Math.trunc(hintMs)), maxMs);
}
