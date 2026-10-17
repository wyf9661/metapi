import { describe, expect, it } from 'vitest';
import {
  CONNECTIVITY_FACTOR_FALSE,
  CONNECTIVITY_FACTOR_NULL,
  CONNECTIVITY_FACTOR_TRUE,
  connectivityLookupKey,
  connectivityScoreFactor,
  freshnessForConnectivity,
  isHardConnectivityFailure,
  softAvoidDisconnectedCandidates,
} from './routeConnectivityLookup.js';

describe('routeConnectivityLookup', () => {
  it('maps connectivity to soft score factors', () => {
    expect(connectivityScoreFactor(true)).toBe(CONNECTIVITY_FACTOR_TRUE);
    expect(connectivityScoreFactor(null)).toBe(CONNECTIVITY_FACTOR_NULL);
    expect(connectivityScoreFactor(false)).toBe(CONNECTIVITY_FACTOR_FALSE);
    expect(CONNECTIVITY_FACTOR_TRUE).toBeGreaterThan(CONNECTIVITY_FACTOR_NULL);
    expect(CONNECTIVITY_FACTOR_NULL).toBeGreaterThan(CONNECTIVITY_FACTOR_FALSE);
  });

  it('expires stale false connectivity back to neutral', () => {
    const now = Date.parse('2026-07-21T00:00:00Z');
    const recentFalse = freshnessForConnectivity(false, now - 60_000, now);
    const staleFalse = freshnessForConnectivity(false, now - 48 * 60 * 60 * 1000, now);
    const recentTrue = freshnessForConnectivity(true, now - 60_000, now);
    expect(recentFalse).toBe(false);
    expect(staleFalse).toBeNull();
    expect(recentTrue).toBe(true);
    // Negative marks expire after the 10-minute TTL: a flapping relay is retried
    // quickly, a recovered upstream never stays soft-avoided for an hour.
    expect(freshnessForConnectivity(false, now - 2 * 60 * 60 * 1000, now)).toBeNull();
    expect(freshnessForConnectivity(false, now - 30 * 60 * 1000, now)).toBeNull();
    expect(freshnessForConnectivity(false, now - 5 * 60 * 1000, now)).toBe(false);
  });

  it('treats only transport-level failures as connectivity evidence', () => {
    // 4xx and rate limits must not mark a channel unreachable — they are
    // request-shape / policy / credential-scope issues handled by cooldowns.
    expect(isHardConnectivityFailure('failed', 400)).toBe(false);
    expect(isHardConnectivityFailure('failed', 403)).toBe(false);
    expect(isHardConnectivityFailure('failed', 404)).toBe(false);
    expect(isHardConnectivityFailure('failed', 402)).toBe(false);
    expect(isHardConnectivityFailure('failed', 429)).toBe(false);
    // Network errors, first-byte timeouts and upstream 5xx are reachability proof.
    expect(isHardConnectivityFailure('failed', 0)).toBe(true);
    expect(isHardConnectivityFailure('failed', 408)).toBe(true);
    expect(isHardConnectivityFailure('failed', 500)).toBe(true);
    expect(isHardConnectivityFailure('failed', 502)).toBe(true);
    expect(isHardConnectivityFailure('failed', 504)).toBe(true);
    // Successes (and non-failed statuses) never touch the flag.
    expect(isHardConnectivityFailure('success', 200)).toBe(false);
    expect(isHardConnectivityFailure(null, 0)).toBe(false);
  });

  it('soft-avoids disconnected candidates only when alternatives exist', () => {
    const pool = [
      { id: 1, connectivity: false as const },
      { id: 2, connectivity: true as const },
      { id: 3, connectivity: null },
    ];
    const filtered = softAvoidDisconnectedCandidates(pool, (row) => row.connectivity);
    expect(filtered.candidates.map((row) => row.id)).toEqual([2, 3]);
    expect(filtered.avoided.map((row) => row.candidate.id)).toEqual([1]);
  });

  it('keeps all candidates when every connectivity is false', () => {
    const pool = [
      { id: 1, connectivity: false as const },
      { id: 2, connectivity: false as const },
    ];
    const filtered = softAvoidDisconnectedCandidates(pool, (row) => row.connectivity);
    expect(filtered.candidates.map((row) => row.id)).toEqual([1, 2]);
    expect(filtered.avoided).toEqual([]);
  });

  it('builds stable account/model lookup keys', () => {
    expect(connectivityLookupKey(12, 'GPT-4o')).toBe(connectivityLookupKey(12, 'gpt-4o'));
  });
});
