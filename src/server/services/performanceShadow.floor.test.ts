import { describe, expect, it } from 'vitest';
import {
  resolveAdaptiveFirstByteFloorMs,
  type PerformanceShadowAttempt,
} from './performanceShadow.js';

const FLOOR = 8_000;
const CEILING = 120_000;
const B = 1_000_000;

function success(ttftMs: number, atMs: number): PerformanceShadowAttempt {
  return { atMs, outcome: 'success', firstByteLatencyMs: ttftMs, budgetMs: null };
}

function timeout(budgetMs: number, atMs: number): PerformanceShadowAttempt {
  return { atMs, outcome: 'timeout', firstByteLatencyMs: null, budgetMs };
}

function error(atMs: number): PerformanceShadowAttempt {
  return { atMs, outcome: 'error', firstByteLatencyMs: null, budgetMs: null };
}

function floorOf(attempts: PerformanceShadowAttempt[], floorMs = FLOOR, ceilingMs = CEILING) {
  return resolveAdaptiveFirstByteFloorMs({ attempts, floorMs, ceilingMs });
}

const run = (count: number, make: (index: number) => PerformanceShadowAttempt) =>
  Array.from({ length: count }, (_, index) => make(index));

describe('adaptive first-byte floor: lift, and release after recovery', () => {
  it('lifts the floor one rung above an isolated censored timeout', () => {
    const attempts = [
      ...run(4, (i) => success(2_000, B + i)),
      timeout(8_000, B + 4),
      ...run(3, (i) => success(2_000, B + 5 + i)),
    ];
    // One censored sample at 8s is evidence the tail is at least that long.
    expect(floorOf(attempts)).toBe(12_000);
  });

  it('releases the lift after the site answers fast for a sustained run', () => {
    // Same shape, but the site keeps answering at 2s afterwards. The lifted
    // floor would otherwise keep every attempt waiting for a tail that no
    // longer exists — the one-way half of this rule.
    const attempts = [
      ...run(4, (i) => success(2_000, B + i)),
      timeout(8_000, B + 4),
      ...run(6, (i) => success(2_000, B + 5 + i)),
    ];
    expect(floorOf(attempts)).toBe(FLOOR);
  });

  it('comes back down after a slow period even while the censored sample is still on record', () => {
    // 90s timeouts, then the link recovers to ~12s answers. Waiting for those
    // timeout rows to slide out of the lookback means hours of dead air on a
    // low-traffic bucket; the recovered distribution has to be able to release
    // the lift itself.
    const attempts = [
      success(2_000, B), timeout(90_000, B + 1), success(2_000, B + 2),
      timeout(90_000, B + 3), success(2_000, B + 4),
      ...run(6, (i) => success(12_000 + (i * 200), B + 5 + i)),
    ];
    expect(floorOf(attempts)).toBe(FLOOR);
  });

  it('keeps the lift while the site is genuinely slow', () => {
    // A slow site is not a recovered one: answers at 90s are above the fast
    // threshold (0.6 x lifted floor), so the lift must survive.
    const attempts = [
      ...run(4, (i) => success(90_000, B + i)),
      timeout(94_000, B + 4),
      ...run(8, (i) => success(92_000, B + 5 + i)),
    ];
    expect(floorOf(attempts)).toBeGreaterThan(FLOOR);
  });

  it('does not ratchet on a run of consecutive timeouts', () => {
    const attempts = [
      ...run(2, (i) => success(2_000, B + i)),
      timeout(8_000, B + 2),
      ...run(4, (i) => timeout(8_000, B + 3 + i)),
    ];
    // Only the first timeout is isolated; a dead channel must not push the
    // window toward the ceiling where every failure waits longer.
    expect(floorOf(attempts)).toBe(12_000);
  });

  it('re-lifts when a later isolated timeout lands after the fast run', () => {
    const attempts = [
      ...run(4, (i) => success(2_000, B + i)),
      timeout(8_000, B + 4),
      ...run(6, (i) => success(2_000, B + 5 + i)),
      timeout(8_000, B + 11),
    ];
    // The run released the lift, but the newest evidence is again a timeout:
    // the site is jittering, not fast.
    expect(floorOf(attempts)).toBe(12_000);
  });

  it('does not treat a timeout after an error as isolated evidence', () => {
    const attempts = [
      success(2_000, B), error(B + 1), timeout(8_000, B + 2),
      success(2_000, B + 3), error(B + 4), timeout(8_000, B + 5),
      ...run(2, (i) => success(2_000, B + 6 + i)),
    ];
    expect(floorOf(attempts)).toBe(FLOOR);
  });

  it('does not let one extreme success outlier lift the floor', () => {
    // Bimodal relay: nine answers at 2s and one at 45s. The cost optimiser is
    // allowed to reject that tail deliberately; the floor must not pin it.
    const attempts = [
      ...run(9, (i) => success(2_000, B + i)),
      success(45_000, B + 9),
    ];
    expect(floorOf(attempts)).toBe(FLOOR);
  });

  it('respects the ceiling and an empty history', () => {
    expect(floorOf([])).toBe(FLOOR);
    const attempts = [
      ...run(5, (i) => success(60_000, B + i)),
      timeout(90_000, B + 5),
      success(60_000, B + 6),
    ];
    expect(floorOf(attempts, FLOOR, 70_000)).toBeLessThanOrEqual(70_000);
  });
});
