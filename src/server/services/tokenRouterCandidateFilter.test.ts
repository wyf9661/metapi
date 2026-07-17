import { describe, expect, it } from 'vitest';
import {
  filterRecentlyFailedCandidates,
  isChannelRecentlyFailed,
} from './tokenRouterCandidateFilter.js';

describe('tokenRouterCandidateFilter', () => {
  const maxCooldownMs = 30 * 24 * 60 * 60_000;

  it('uses fibonacci backoff and ignores invalid timestamps', () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z');
    expect(isChannelRecentlyFailed({
      failCount: 4,
      lastFailAt: new Date(now - 40_000).toISOString(),
    }, now, maxCooldownMs)).toBe(true);
    expect(isChannelRecentlyFailed({
      failCount: 4,
      lastFailAt: new Date(now - 50_000).toISOString(),
    }, now, maxCooldownMs)).toBe(false);
    expect(isChannelRecentlyFailed({ failCount: 4, lastFailAt: 'invalid' }, now, maxCooldownMs)).toBe(false);
  });

  it('respects an explicit avoidance window and maximum cooldown clamp', () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z');
    const channel = { failCount: 99, lastFailAt: new Date(now - 61_000).toISOString() };
    expect(isChannelRecentlyFailed(channel, now, 60_000, 600)).toBe(false);
    expect(isChannelRecentlyFailed(channel, now, 120_000, 600)).toBe(true);
  });

  it('filters cooling candidates when a healthy alternative exists', () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z');
    const candidates = [
      { id: 'cooling', channel: { failCount: 2, lastFailAt: new Date(now - 5_000).toISOString() } },
      { id: 'healthy', channel: { failCount: 0, lastFailAt: null } },
    ];
    expect(filterRecentlyFailedCandidates(candidates, now, maxCooldownMs).map((item) => item.id))
      .toEqual(['healthy']);
  });

  it('keeps every candidate when all are cooling down', () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z');
    const candidates = [
      { id: 'a', channel: { failCount: 2, lastFailAt: new Date(now - 5_000).toISOString() } },
      { id: 'b', channel: { failCount: 3, lastFailAt: new Date(now - 5_000).toISOString() } },
    ];
    expect(filterRecentlyFailedCandidates(candidates, now, maxCooldownMs).map((item) => item.id))
      .toEqual(['a', 'b']);
  });

  it('disables filtering when the explicit window is zero', () => {
    const now = Date.parse('2026-07-17T12:00:00.000Z');
    const candidates = [
      { id: 'cooling', channel: { failCount: 2, lastFailAt: new Date(now - 5_000).toISOString() } },
      { id: 'healthy', channel: { failCount: 0, lastFailAt: null } },
    ];
    expect(filterRecentlyFailedCandidates(candidates, now, maxCooldownMs, 0)).toBe(candidates);
  });
});
