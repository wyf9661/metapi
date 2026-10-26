import { describe, expect, it } from 'vitest';
import {
  parseGoDurationMs,
  parseUpstreamRetryHint,
  resolveUpstreamInformedCooldownMs,
  UPSTREAM_RETRY_HINT_MAX_MS,
} from './upstreamRetryAfter.js';

/** Minimal stand-in for undici's Headers: case-insensitive get + entries(). */
function headersOf(entries: Record<string, string>) {
  const pairs = Object.entries(entries);
  return {
    get(name: string): string | null {
      const lower = name.toLowerCase();
      const found = pairs.find(([key]) => key.toLowerCase() === lower);
      return found ? found[1] : null;
    },
    entries(): Iterable<[string, string]> {
      return pairs;
    },
  };
}

const NOW = Date.parse('2026-10-26T12:00:00Z');

describe('parseGoDurationMs', () => {
  it('parses single and compound units', () => {
    expect(parseGoDurationMs('6m0s')).toBe(360_000);
    expect(parseGoDurationMs('1h2m3s')).toBe(3_723_000);
    expect(parseGoDurationMs('250ms')).toBe(250);
    expect(parseGoDurationMs('1.5s')).toBe(1_500);
  });

  it('rejects bare numbers and prose', () => {
    expect(parseGoDurationMs('120')).toBeNull();
    expect(parseGoDurationMs('in 1s')).toBeNull();
    expect(parseGoDurationMs('')).toBeNull();
  });
});

describe('parseUpstreamRetryHint', () => {
  it('returns no hint when the header is absent', () => {
    expect(parseUpstreamRetryHint(headersOf({}), { nowMs: NOW }))
      .toEqual({ retryAfterMs: null, source: null });
    expect(parseUpstreamRetryHint(null, { nowMs: NOW }))
      .toEqual({ retryAfterMs: null, source: null });
  });

  it('reads delta-seconds', () => {
    expect(parseUpstreamRetryHint(headersOf({ 'retry-after': '3' }), { nowMs: NOW }))
      .toEqual({ retryAfterMs: 3_000, source: 'retry-after' });
  });

  it('reads fractional delta-seconds', () => {
    expect(parseUpstreamRetryHint(headersOf({ 'retry-after': '1.5' }), { nowMs: NOW }))
      .toEqual({ retryAfterMs: 1_500, source: 'retry-after' });
  });

  it('reads an HTTP-date as an instant, not a duration', () => {
    const hint = parseUpstreamRetryHint(
      headersOf({ 'retry-after': 'Mon, 26 Oct 2026 12:00:30 GMT' }),
      { nowMs: NOW },
    );
    expect(hint).toEqual({ retryAfterMs: 30_000, source: 'retry-after' });
  });

  it('ignores an unparseable Retry-After and falls through to the reset family', () => {
    const hint = parseUpstreamRetryHint(
      headersOf({ 'retry-after': 'soon', 'x-ratelimit-reset-requests': '6m0s' }),
      { nowMs: NOW },
    );
    expect(hint).toEqual({ retryAfterMs: 360_000, source: 'ratelimit-reset' });
  });

  it('reads a vendor Go-duration reset header', () => {
    expect(parseUpstreamRetryHint(
      headersOf({ 'x-ratelimit-reset-requests': '6m0s' }),
      { nowMs: NOW },
    )).toEqual({ retryAfterMs: 360_000, source: 'ratelimit-reset' });
  });

  it('reads an anthropic-style reset header', () => {
    expect(parseUpstreamRetryHint(
      headersOf({ 'anthropic-ratelimit-tokens-reset': '2026-10-26T12:02:00Z' }),
      { nowMs: NOW },
    )).toEqual({ retryAfterMs: 120_000, source: 'ratelimit-reset' });
  });

  it('reads epoch seconds and epoch milliseconds', () => {
    const epochSeconds = String(Math.floor((NOW + 45_000) / 1000));
    expect(parseUpstreamRetryHint(headersOf({ 'ratelimit-reset': epochSeconds }), { nowMs: NOW }))
      .toEqual({ retryAfterMs: 45_000, source: 'ratelimit-reset' });

    const epochMs = String(NOW + 20_000);
    expect(parseUpstreamRetryHint(headersOf({ 'ratelimit-reset': epochMs }), { nowMs: NOW }))
      .toEqual({ retryAfterMs: 20_000, source: 'ratelimit-reset' });
  });

  it('takes the longest wait when several reset headers disagree', () => {
    expect(parseUpstreamRetryHint(
      headersOf({ 'x-ratelimit-reset-requests': '30s', 'x-ratelimit-reset-tokens': '2m' }),
      { nowMs: NOW },
    )).toEqual({ retryAfterMs: 120_000, source: 'ratelimit-reset' });
  });

  it('clamps an absurd wait to the cap', () => {
    expect(parseUpstreamRetryHint(headersOf({ 'retry-after': '86400' }), { nowMs: NOW }))
      .toEqual({ retryAfterMs: UPSTREAM_RETRY_HINT_MAX_MS, source: 'retry-after' });
  });

  it('treats a past instant as no hint', () => {
    expect(parseUpstreamRetryHint(
      headersOf({ 'ratelimit-reset': '2026-10-26T11:00:00Z' }),
      { nowMs: NOW },
    )).toEqual({ retryAfterMs: null, source: null });
  });

  it('ignores headers that are not rate-limit resets', () => {
    expect(parseUpstreamRetryHint(
      headersOf({ 'x-request-reset': '60', 'x-ratelimit-limit': '100' }),
      { nowMs: NOW },
    )).toEqual({ retryAfterMs: null, source: null });
  });
});

describe('resolveUpstreamInformedCooldownMs', () => {
  it('keeps the local backoff when the vendor says nothing', () => {
    expect(resolveUpstreamInformedCooldownMs(30_000, null)).toBe(30_000);
    expect(resolveUpstreamInformedCooldownMs(30_000, undefined)).toBe(30_000);
    expect(resolveUpstreamInformedCooldownMs(30_000, 0)).toBe(30_000);
  });

  it('waits longer when the vendor asks for longer', () => {
    expect(resolveUpstreamInformedCooldownMs(15_000, 600_000)).toBe(600_000);
  });

  it('never shortens the local backoff', () => {
    expect(resolveUpstreamInformedCooldownMs(30_000, 1_000)).toBe(30_000);
  });

  it('honours the outer cap', () => {
    expect(resolveUpstreamInformedCooldownMs(15_000, 600_000, 300_000)).toBe(300_000);
    expect(resolveUpstreamInformedCooldownMs(400_000, null, 300_000)).toBe(300_000);
  });
});
