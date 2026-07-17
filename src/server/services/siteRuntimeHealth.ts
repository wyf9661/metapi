import {
  isTransientSiteRuntimeFailure,
  resolveSiteRuntimeFailurePenalty,
  type SiteRuntimeFailureContext,
} from './siteFailureClassification.js';
import {
  buildRecentOutcomeSnapshot,
  clampNumber,
  readFiniteInteger,
  readFiniteNumber,
  readNullableTimestamp,
  resolveSiteRuntimeBreakerMs,
  type RecentOutcomeSnapshot,
  SITE_RUNTIME_BREAKER_LEVELS_MS as SITE_RUNTIME_BREAKER_LEVELS_MS_CONST,
} from './tokenRouterMath.js';

export type SiteRuntimeHealthState = {
  penaltyScore: number;
  latencyEmaMs: number | null;
  transientFailureStreak: number;
  lastTransientFailureAtMs: number | null;
  recentSuccessCount: number;
  recentFailureCount: number;
  recentWindowUpdatedAtMs: number;
  breakerLevel: number;
  breakerUntilMs: number | null;
  lastUpdatedAtMs: number;
  lastFailureAtMs: number | null;
  lastSuccessAtMs: number | null;
};

export const SITE_RUNTIME_HEALTH_DECAY_HALF_LIFE_MS = 10 * 60 * 1000;
export const SITE_RECENT_OUTCOME_HALF_LIFE_MS = 30 * 60 * 1000;
export const SITE_RUNTIME_MIN_MULTIPLIER = 0.08;
export const SITE_RUNTIME_LATENCY_BASELINE_MS = 2_500;
export const SITE_RUNTIME_LATENCY_WINDOW_MS = 30_000;
export const SITE_RUNTIME_MAX_LATENCY_PENALTY = 0.35;
export const SITE_RUNTIME_LATENCY_EMA_ALPHA = 0.3;
export const SITE_RUNTIME_BREAKER_STREAK_THRESHOLD = 3;
export const SITE_TRANSIENT_STREAK_WINDOW_MS = 5 * 60 * 1000;
export const SITE_RUNTIME_HEALTH_PERSIST_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SITE_RUNTIME_HEALTH_PERSIST_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
export const SITE_RUNTIME_HEALTH_PERSIST_MIN_PENALTY = 0.02;
export const SITE_RUNTIME_BREAKER_LEVELS_MS = SITE_RUNTIME_BREAKER_LEVELS_MS_CONST;

export function createSiteRuntimeHealthState(nowMs = Date.now()): SiteRuntimeHealthState {
  return {
    penaltyScore: 0,
    latencyEmaMs: null,
    transientFailureStreak: 0,
    lastTransientFailureAtMs: null,
    recentSuccessCount: 0,
    recentFailureCount: 0,
    recentWindowUpdatedAtMs: nowMs,
    breakerLevel: 0,
    breakerUntilMs: null,
    lastUpdatedAtMs: nowMs,
    lastFailureAtMs: null,
    lastSuccessAtMs: null,
  };
}

export function getDecayedSiteRuntimePenalty(state: SiteRuntimeHealthState, nowMs: number): number {
  if (!Number.isFinite(state.penaltyScore) || state.penaltyScore <= 0) return 0;
  const elapsedMs = Math.max(0, nowMs - state.lastUpdatedAtMs);
  if (elapsedMs <= 0) return state.penaltyScore;
  const decayFactor = Math.pow(0.5, elapsedMs / SITE_RUNTIME_HEALTH_DECAY_HALF_LIFE_MS);
  return state.penaltyScore * decayFactor;
}

export function getRecentSiteRuntimeOutcomeSnapshot(
  state: SiteRuntimeHealthState | null | undefined,
  nowMs = Date.now(),
): RecentOutcomeSnapshot {
  if (!state) return buildRecentOutcomeSnapshot(0, 0);
  const elapsedMs = Math.max(0, nowMs - state.recentWindowUpdatedAtMs);
  const decayFactor = Math.pow(0.5, elapsedMs / SITE_RECENT_OUTCOME_HALF_LIFE_MS);
  return buildRecentOutcomeSnapshot(
    state.recentSuccessCount * decayFactor,
    state.recentFailureCount * decayFactor,
  );
}

function refreshRecentOutcomeWindow(state: SiteRuntimeHealthState, nowMs: number): void {
  const snapshot = getRecentSiteRuntimeOutcomeSnapshot(state, nowMs);
  state.recentSuccessCount = snapshot.successCount;
  state.recentFailureCount = snapshot.failureCount;
  state.recentWindowUpdatedAtMs = nowMs;
}

export function hydrateSiteRuntimeHealthState(raw: unknown, nowMs = Date.now()): SiteRuntimeHealthState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const lastUpdatedAtMs = readFiniteInteger(record.lastUpdatedAtMs) ?? nowMs;
  const recentWindowUpdatedAtMs = readFiniteInteger(record.recentWindowUpdatedAtMs) ?? lastUpdatedAtMs;
  return {
    penaltyScore: Math.max(0, readFiniteNumber(record.penaltyScore) ?? 0),
    latencyEmaMs: readFiniteNumber(record.latencyEmaMs),
    transientFailureStreak: Math.max(0, readFiniteInteger(record.transientFailureStreak) ?? 0),
    lastTransientFailureAtMs: readNullableTimestamp(record.lastTransientFailureAtMs),
    recentSuccessCount: Math.max(0, readFiniteNumber(record.recentSuccessCount) ?? 0),
    recentFailureCount: Math.max(0, readFiniteNumber(record.recentFailureCount) ?? 0),
    recentWindowUpdatedAtMs: Math.max(0, recentWindowUpdatedAtMs),
    breakerLevel: Math.max(0, readFiniteInteger(record.breakerLevel) ?? 0),
    breakerUntilMs: readNullableTimestamp(record.breakerUntilMs),
    lastUpdatedAtMs: Math.max(0, lastUpdatedAtMs),
    lastFailureAtMs: readNullableTimestamp(record.lastFailureAtMs),
    lastSuccessAtMs: readNullableTimestamp(record.lastSuccessAtMs),
  };
}

export function cloneSiteRuntimeHealthState(state: SiteRuntimeHealthState): SiteRuntimeHealthState {
  return { ...state };
}

export function isRuntimeHealthBreakerOpen(
  state: SiteRuntimeHealthState | null | undefined,
  nowMs = Date.now(),
): boolean {
  return Boolean(state && typeof state.breakerUntilMs === 'number' && state.breakerUntilMs > nowMs);
}

export function getRuntimeHealthMultiplier(
  state: SiteRuntimeHealthState | null | undefined,
  nowMs = Date.now(),
): number {
  if (!state) return 1;
  if (isRuntimeHealthBreakerOpen(state, nowMs)) return SITE_RUNTIME_MIN_MULTIPLIER;
  const penaltyScore = getDecayedSiteRuntimePenalty(state, nowMs);
  const failurePenaltyFactor = 1 / (1 + penaltyScore);
  const latencyPenaltyRatio = state.latencyEmaMs == null
    ? 0
    : clampNumber(
      (state.latencyEmaMs - SITE_RUNTIME_LATENCY_BASELINE_MS) / SITE_RUNTIME_LATENCY_WINDOW_MS,
      0,
      1,
    );
  const latencyFactor = 1 - (latencyPenaltyRatio * SITE_RUNTIME_MAX_LATENCY_PENALTY);
  return clampNumber(failurePenaltyFactor * latencyFactor, SITE_RUNTIME_MIN_MULTIPLIER, 1);
}

export function applyRuntimeHealthFailure(
  state: SiteRuntimeHealthState,
  context: SiteRuntimeFailureContext = {},
  nowMs = Date.now(),
): void {
  refreshRecentOutcomeWindow(state, nowMs);
  state.recentFailureCount += 1;
  state.penaltyScore += resolveSiteRuntimeFailurePenalty(context);
  if (isTransientSiteRuntimeFailure(context)) {
    const shouldContinueStreak = typeof state.lastTransientFailureAtMs === 'number'
      && (nowMs - state.lastTransientFailureAtMs) <= SITE_TRANSIENT_STREAK_WINDOW_MS;
    state.transientFailureStreak = shouldContinueStreak ? state.transientFailureStreak + 1 : 1;
    state.lastTransientFailureAtMs = nowMs;
    if (state.transientFailureStreak >= SITE_RUNTIME_BREAKER_STREAK_THRESHOLD) {
      state.breakerLevel = Math.min(state.breakerLevel + 1, SITE_RUNTIME_BREAKER_LEVELS_MS.length - 1);
      const breakerMs = resolveSiteRuntimeBreakerMs(state.breakerLevel);
      state.breakerUntilMs = breakerMs > 0 ? nowMs + breakerMs : null;
      state.transientFailureStreak = 0;
    }
  } else {
    state.transientFailureStreak = 0;
    state.lastTransientFailureAtMs = null;
  }
  state.lastFailureAtMs = nowMs;
}

export function applyRuntimeHealthSuccess(
  state: SiteRuntimeHealthState,
  latencyMs: number,
  nowMs = Date.now(),
): void {
  refreshRecentOutcomeWindow(state, nowMs);
  state.recentSuccessCount += 1;
  state.penaltyScore = Math.max(0, state.penaltyScore * 0.2 - 0.3);
  state.transientFailureStreak = 0;
  state.lastTransientFailureAtMs = null;
  state.breakerLevel = 0;
  state.breakerUntilMs = null;
  state.lastSuccessAtMs = nowMs;
  const normalizedLatencyMs = Math.max(0, Math.trunc(latencyMs));
  state.latencyEmaMs = state.latencyEmaMs == null
    ? normalizedLatencyMs
    : (state.latencyEmaMs * (1 - SITE_RUNTIME_LATENCY_EMA_ALPHA))
      + (normalizedLatencyMs * SITE_RUNTIME_LATENCY_EMA_ALPHA);
}

export function shouldPersistSiteRuntimeHealthState(
  state: SiteRuntimeHealthState,
  nowMs = Date.now(),
): boolean {
  const lastTouchedAtMs = Math.max(
    state.lastUpdatedAtMs,
    state.lastFailureAtMs ?? 0,
    state.lastSuccessAtMs ?? 0,
    state.lastTransientFailureAtMs ?? 0,
  );
  if ((nowMs - lastTouchedAtMs) > SITE_RUNTIME_HEALTH_PERSIST_STALE_TTL_MS) return false;
  if (isRuntimeHealthBreakerOpen(state, nowMs)) return true;
  if (getDecayedSiteRuntimePenalty(state, nowMs) >= SITE_RUNTIME_HEALTH_PERSIST_MIN_PENALTY) return true;
  if (getRecentSiteRuntimeOutcomeSnapshot(state, nowMs).sampleCount > 0.01) return true;
  if ((state.latencyEmaMs ?? 0) > 0) return true;
  return (nowMs - lastTouchedAtMs) <= SITE_RUNTIME_HEALTH_PERSIST_IDLE_TTL_MS;
}
