import { describe, expect, it } from 'vitest';
import {
  applyRuntimeHealthFailure,
  applyRuntimeHealthSuccess,
  createSiteRuntimeHealthState,
  getDecayedSiteRuntimePenalty,
  getRecentSiteRuntimeOutcomeSnapshot,
  getRuntimeHealthMultiplier,
  hydrateSiteRuntimeHealthState,
  isRuntimeHealthBreakerOpen,
  shouldPersistSiteRuntimeHealthState,
} from './siteRuntimeHealth.js';

describe('siteRuntimeHealth', () => {
  it('decays penalties and reduces the health multiplier for slow sites', () => {
    const now = 1_000_000;
    const state = createSiteRuntimeHealthState(now);
    state.penaltyScore = 2;
    state.latencyEmaMs = 32_500;

    expect(getDecayedSiteRuntimePenalty(state, now + 10 * 60_000)).toBeCloseTo(1, 6);
    expect(getRuntimeHealthMultiplier(state, now)).toBeLessThan(0.25);
  });

  it('opens a breaker after three transient failures and closes it on success', () => {
    const now = 2_000_000;
    const state = createSiteRuntimeHealthState(now);
    for (let index = 0; index < 3; index += 1) {
      applyRuntimeHealthFailure(state, { status: 502, errorText: 'Bad gateway' }, now + index * 1_000);
    }

    expect(isRuntimeHealthBreakerOpen(state, now + 3_000)).toBe(true);
    expect(getRuntimeHealthMultiplier(state, now + 3_000)).toBe(0.08);

    applyRuntimeHealthSuccess(state, 800, now + 4_000);
    expect(isRuntimeHealthBreakerOpen(state, now + 4_000)).toBe(false);
    expect(state.breakerLevel).toBe(0);
    expect(state.latencyEmaMs).toBe(800);
  });

  it('decays recent outcomes on the dedicated 30-minute window', () => {
    const now = 3_000_000;
    const state = createSiteRuntimeHealthState(now);
    state.recentSuccessCount = 8;
    state.recentFailureCount = 2;

    const snapshot = getRecentSiteRuntimeOutcomeSnapshot(state, now + 30 * 60_000);
    expect(snapshot.successCount).toBeCloseTo(4, 6);
    expect(snapshot.failureCount).toBeCloseTo(1, 6);
  });

  it('hydrates valid persisted state and rejects invalid payloads', () => {
    expect(hydrateSiteRuntimeHealthState(null)).toBeNull();
    expect(hydrateSiteRuntimeHealthState({
      penaltyScore: 1.5,
      latencyEmaMs: 900,
      breakerLevel: 1,
      breakerUntilMs: 5_000,
      lastUpdatedAtMs: 1_000,
    }, 2_000)).toMatchObject({
      penaltyScore: 1.5,
      latencyEmaMs: 900,
      breakerLevel: 1,
      breakerUntilMs: 5_000,
      lastUpdatedAtMs: 1_000,
    });
  });

  it('drops stale idle state while retaining recent health evidence', () => {
    const now = 10 * 24 * 60 * 60_000;
    const stale = createSiteRuntimeHealthState(0);
    expect(shouldPersistSiteRuntimeHealthState(stale, now)).toBe(false);

    const recent = createSiteRuntimeHealthState(now - 1_000);
    recent.recentFailureCount = 1;
    expect(shouldPersistSiteRuntimeHealthState(recent, now)).toBe(true);
  });
});

  it('opens a short breaker immediately when endpoint pool is exhausted', () => {
    const state = createSiteRuntimeHealthState(0);
    applyRuntimeHealthFailure(state, { errorText: '当前站点的 API 请求地址均不可用' }, 1_000);
    expect(isRuntimeHealthBreakerOpen(state, 1_000)).toBe(true);
    expect(state.breakerLevel).toBeGreaterThanOrEqual(1);
  });
