import { describe, expect, it } from 'vitest';
import {
  blendRecentOutcomeSnapshots,
  buildRecentOutcomeSnapshot,
  clampFailureCooldownMs,
  clampNumber,
  decayRecentOutcomeCount,
  fibonacciNumber,
  isContributionCloseToBest,
  isRecord,
  readFiniteInteger,
  readFiniteNumber,
  readNullableTimestamp,
  resolveEffectiveFailureCooldownMs,
  resolveFailureBackoffSec,
  resolveRoundRobinCooldownSec,
  resolveSiteRuntimeBreakerMs,
  FAILURE_BACKOFF_BASE_SEC,
  MAX_FAILURE_BACKOFF_SEC,
  ROUND_ROBIN_COOLDOWN_LEVELS_SEC,
  SITE_RUNTIME_BREAKER_LEVELS_MS,
} from './tokenRouterMath.js';

describe('tokenRouterMath', () => {
  it('computes fibonacci and failure backoff', () => {
    expect(fibonacciNumber(1)).toBe(1);
    expect(fibonacciNumber(2)).toBe(1);
    expect(fibonacciNumber(5)).toBe(5);
    expect(resolveFailureBackoffSec(1)).toBe(FAILURE_BACKOFF_BASE_SEC);
    expect(resolveFailureBackoffSec(5)).toBe(FAILURE_BACKOFF_BASE_SEC * 5);
    expect(resolveFailureBackoffSec(10_000)).toBe(MAX_FAILURE_BACKOFF_SEC);
  });

  it('clamps failure cooldown to configured max', () => {
    expect(clampFailureCooldownMs(500, 60_000)).toBe(500);
    expect(clampFailureCooldownMs(999_999, 60_000)).toBe(60_000);
    expect(resolveEffectiveFailureCooldownMs(1, 30_000)).toBe(
      Math.min(FAILURE_BACKOFF_BASE_SEC * 1000, 30_000),
    );
  });

  it('resolves round-robin and breaker ladders', () => {
    expect(resolveRoundRobinCooldownSec(0)).toBe(ROUND_ROBIN_COOLDOWN_LEVELS_SEC[0]);
    expect(resolveRoundRobinCooldownSec(2)).toBe(ROUND_ROBIN_COOLDOWN_LEVELS_SEC[2]);
    expect(resolveRoundRobinCooldownSec(99)).toBe(
      ROUND_ROBIN_COOLDOWN_LEVELS_SEC[ROUND_ROBIN_COOLDOWN_LEVELS_SEC.length - 1],
    );
    expect(resolveSiteRuntimeBreakerMs(1)).toBe(SITE_RUNTIME_BREAKER_LEVELS_MS[1]);
    expect(resolveSiteRuntimeBreakerMs(-3)).toBe(SITE_RUNTIME_BREAKER_LEVELS_MS[0]);
  });

  it('clamps numbers and contribution ratios', () => {
    expect(clampNumber(5, 0, 1)).toBe(1);
    expect(clampNumber(-1, 0, 1)).toBe(0);
    expect(isContributionCloseToBest(0.95, 1, 0.92)).toBe(true);
    expect(isContributionCloseToBest(0.5, 1, 0.92)).toBe(false);
    expect(isContributionCloseToBest(0.1, 0)).toBe(true);
  });

  it('reads finite numbers / timestamps safely', () => {
    expect(readFiniteNumber(1.5)).toBe(1.5);
    expect(readFiniteNumber(Number.NaN)).toBeNull();
    expect(readFiniteInteger(3.8)).toBe(3);
    expect(readNullableTimestamp(0)).toBeNull();
    expect(readNullableTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1])).toBe(false);
  });

  it('decays and blends recent outcome windows', () => {
    expect(decayRecentOutcomeCount(8, 0)).toBe(8);
    expect(decayRecentOutcomeCount(8, 30 * 60 * 1000)).toBeCloseTo(4, 5);

    const snapshot = buildRecentOutcomeSnapshot(9, 3);
    expect(snapshot.sampleCount).toBe(12);
    expect(snapshot.successRate).toBeCloseTo(10 / 14, 5);
    expect(snapshot.confidence).toBeCloseTo(1, 5);

    const blended = blendRecentOutcomeSnapshots(
      buildRecentOutcomeSnapshot(10, 0),
      buildRecentOutcomeSnapshot(0, 10),
      0.5,
    );
    expect(blended.successCount).toBeCloseTo(5, 5);
    expect(blended.failureCount).toBeCloseTo(5, 5);
  });
});
