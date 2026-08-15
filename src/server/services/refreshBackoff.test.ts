import { describe, expect, it } from 'vitest';
import {
  REFRESH_BACKOFF_BASE_MS,
  REFRESH_BACKOFF_MAX_MS,
  advanceRefreshBackoff,
  isRefreshBackoffActive,
  resolveRefreshBackoffMs,
} from './refreshBackoff.js';

describe('refreshBackoff', () => {
  it('resolves exponential backoff capped at the max', () => {
    expect(resolveRefreshBackoffMs(0)).toBe(0);
    expect(resolveRefreshBackoffMs(1)).toBe(REFRESH_BACKOFF_BASE_MS);
    expect(resolveRefreshBackoffMs(2)).toBe(REFRESH_BACKOFF_BASE_MS * 2);
    expect(resolveRefreshBackoffMs(3)).toBe(REFRESH_BACKOFF_BASE_MS * 4);
    expect(resolveRefreshBackoffMs(4)).toBe(REFRESH_BACKOFF_BASE_MS * 8);
    expect(resolveRefreshBackoffMs(5)).toBe(REFRESH_BACKOFF_MAX_MS);
    expect(resolveRefreshBackoffMs(100)).toBe(REFRESH_BACKOFF_MAX_MS);
  });

  it('treats non-finite fail counts as no backoff', () => {
    expect(resolveRefreshBackoffMs(Number.NaN)).toBe(0);
    expect(resolveRefreshBackoffMs(-1)).toBe(0);
  });

  it('detects an active retry window only when retryAtMs is in the future', () => {
    const now = 1_000_000;
    expect(isRefreshBackoffActive(now + 1, now)).toBe(true);
    expect(isRefreshBackoffActive(now, now)).toBe(false);
    expect(isRefreshBackoffActive(now - 1, now)).toBe(false);
    expect(isRefreshBackoffActive(undefined, now)).toBe(false);
    expect(isRefreshBackoffActive(null, now)).toBe(false);
    expect(isRefreshBackoffActive(Number.NaN, now)).toBe(false);
  });

  it('advances from the previous failure count and returns the next retry timestamp', () => {
    const now = 1_000_000;
    expect(advanceRefreshBackoff(undefined, now)).toEqual({
      failCount: 1,
      retryAtMs: now + REFRESH_BACKOFF_BASE_MS,
    });
    expect(advanceRefreshBackoff(3, now)).toEqual({
      failCount: 4,
      retryAtMs: now + REFRESH_BACKOFF_BASE_MS * 8,
    });
    expect(advanceRefreshBackoff(0, now)).toEqual({
      failCount: 1,
      retryAtMs: now + REFRESH_BACKOFF_BASE_MS,
    });
  });
});
