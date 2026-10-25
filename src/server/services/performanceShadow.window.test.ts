import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPerformanceShadowMetrics,
  estimateFirstByteWindowMs,
  FIRST_BYTE_WINDOW_MIN_SAMPLES,
  listPerformanceShadowAttempts,
  recordPerformanceShadowAttempt,
} from './performanceShadow.js';

const KEY = { routeId: 1, siteId: 7, modelName: 'deepseek-v4.1-flash', isStream: true };
const FLOOR = 5_000;
const CEILING = 90_000;
// The attempt store sweeps by wall clock, so fixtures must live near `now`
// rather than at epoch zero or they are pruned before the estimator reads them.
const BASE_NOW = Date.now();

function seedSuccesses(values: number[], startAt = BASE_NOW - 60_000): void {
  values.forEach((value, index) => {
    recordPerformanceShadowAttempt({
      key: KEY,
      outcome: 'success',
      firstByteLatencyMs: value,
      nowMs: startAt + index,
    });
  });
}

function estimate(overrides: { currentMs?: number | null } = {}) {
  return estimateFirstByteWindowMs({
    key: KEY,
    floorMs: FLOOR,
    ceilingMs: CEILING,
    nowMs: BASE_NOW,
    ...overrides,
  });
}

describe('performanceShadow survival-curve window', () => {
  beforeEach(() => clearPerformanceShadowMetrics());

  it('records censored timeouts instead of dropping them', () => {
    seedSuccesses([2_000, 2_100]);
    recordPerformanceShadowAttempt({ key: KEY, outcome: 'timeout', budgetMs: 30_000, nowMs: BASE_NOW - 10 });
    recordPerformanceShadowAttempt({ key: KEY, outcome: 'error', nowMs: BASE_NOW - 9 });

    const attempts = listPerformanceShadowAttempts(KEY, BASE_NOW);
    expect(attempts).toHaveLength(4);
    expect(attempts.filter((attempt) => attempt.outcome === 'timeout')).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.outcome === 'timeout')?.budgetMs).toBe(30_000);
  });

  it('stays out of the way until it has enough attempts', () => {
    seedSuccesses([2_000, 2_000, 2_000]);
    expect(estimate()).toBeNull();
    // Filling the minimum makes an estimate available.
    seedSuccesses(Array.from({ length: FIRST_BYTE_WINDOW_MIN_SAMPLES }, () => 2_000), BASE_NOW - 50_000);
    expect(estimate()).not.toBeNull();
  });

  it('cuts at the fast mode of a bimodal relay instead of averaging the modes', () => {
    // 70% of attempts hit a fast internal channel (2s); 30% land on a queued one
    // (45s). A mean/EWMA lands in the empty gap (~15s) and fits neither.
    const mixed = [
      ...Array.from({ length: 14 }, () => 2_000),
      ...Array.from({ length: 6 }, () => 45_000),
    ];
    seedSuccesses(mixed);

    const window = estimate();
    expect(window).not.toBeNull();
    // Floor wins here (5s), but the point is that it sits at the fast mode and
    // nowhere near the ~15s midpoint a mean/EWMA would produce.
    expect(window!).toBeLessThanOrEqual(FLOOR);
    expect(window!).toBeLessThan(30_000);
  });

  it('learns from censored timeouts: a window that keeps timing out is widened', () => {
    // Successes need 12s but the estimator only ever saw a 5s window expire.
    seedSuccesses([12_000, 12_500, 12_200, 11_900]);
    for (let i = 0; i < 8; i += 1) {
      recordPerformanceShadowAttempt({
        key: KEY,
        outcome: 'timeout',
        budgetMs: 5_000,
        nowMs: BASE_NOW - 40_000 + i,
      });
    }

    const window = estimate();
    expect(window).not.toBeNull();
    expect(window!).toBeGreaterThan(FLOOR);
    expect(window!).toBeLessThanOrEqual(CEILING);
  });

  it('never exceeds the configured ceiling, even with a very slow history', () => {
    seedSuccesses([80_000, 85_000, 88_000, 89_000, 87_000, 86_000, 84_000, 82_000]);
    const window = estimate();
    expect(window).not.toBeNull();
    expect(window!).toBeLessThanOrEqual(CEILING);
  });

  it('keeps the current window when it is already within hysteresis of the best', () => {
    seedSuccesses(Array.from({ length: 10 }, () => 2_000));
    expect(estimate({ currentMs: 6_000 })).toBe(6_000);
  });

  it('returns null when every attempt failed (nothing to learn from)', () => {
    for (let i = 0; i < 10; i += 1) {
      recordPerformanceShadowAttempt({ key: KEY, outcome: 'error', nowMs: BASE_NOW - 1_000 + i });
    }
    expect(estimate()).toBeNull();
  });


  // Regression: production 2026-10-25. Antigravity's gemini-3.8-flash is a
  // reasoning model whose healthy first byte lands at 5.0-6.7s. A 5s floor plus
  // "candidates only come from observed successes" censored every slower answer,
  // so the window could never grow past the fastest mode it had already seen.
  it('widens when every success sits above the current floor', () => {
    seedSuccesses([5_063, 6_275, 5_900, 6_100, 5_400, 6_000, 5_700, 6_200]);
    const window = estimate();
    expect(window).not.toBeNull();
    // The window must not sit inside the observed success band: the slowest
    // healthy answer has to fit with headroom, otherwise it gets censored next.
    expect(window!).toBeGreaterThanOrEqual(6_275);
  });

  it('escalates past the slowest success after consecutive trailing timeouts', () => {
    seedSuccesses([5_000, 5_200, 5_400, 5_600, 5_800, 6_000, 6_100, 6_275]);
    // Two attempts expired at the incumbent window: the window is the suspect,
    // not the upstream, so it must widen instead of optimising itself smaller.
    recordPerformanceShadowAttempt({ key: KEY, outcome: 'timeout', budgetMs: 6_300, nowMs: BASE_NOW - 30 });
    recordPerformanceShadowAttempt({ key: KEY, outcome: 'timeout', budgetMs: 6_300, nowMs: BASE_NOW - 20 });

    const window = estimate();
    expect(window).not.toBeNull();
    expect(window!).toBeGreaterThan(6_275);
    expect(window!).toBeLessThanOrEqual(CEILING);
  });

  it('does not let error attempts drag the TTFT window down', () => {
    seedSuccesses([6_000, 6_100, 6_200, 6_300, 6_400, 6_500, 6_600, 6_700]);
    // A burst of 4xx/5xx says nothing about first-byte latency.
    for (let i = 0; i < 12; i += 1) {
      recordPerformanceShadowAttempt({ key: KEY, outcome: 'error', nowMs: BASE_NOW - 500 + i });
    }

    const window = estimate();
    expect(window).not.toBeNull();
    expect(window!).toBeGreaterThanOrEqual(6_700);
  });

  it('ignores attempts outside the 6h window', () => {
    seedSuccesses(Array.from({ length: 10 }, () => 2_000), BASE_NOW - 7 * 60 * 60 * 1000);
    expect(estimate()).toBeNull();
  });
});
