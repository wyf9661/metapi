/**
 * Pure numeric / cooldown helpers used by token routing.
 * Extracted from tokenRouter.ts so backoff, clamp, and recent-outcome math
 * stay free of module state and easy to unit-test.
 */

export const FAILURE_BACKOFF_BASE_SEC = 15;
/** Keep weighted-route backoff within the JavaScript Date range when fail counts grow large. */
export const MAX_FAILURE_BACKOFF_SEC = 30 * 24 * 60 * 60;
export const ROUND_ROBIN_COOLDOWN_LEVELS_SEC = [0, 10 * 60, 60 * 60, 24 * 60 * 60] as const;
export const SITE_RUNTIME_BREAKER_LEVELS_MS = [0, 60_000, 5 * 60_000, 30 * 60 * 1000] as const;
export const STABLE_FIRST_SITE_SCORE_RATIO = 0.92;
export const SITE_RECENT_OUTCOME_HALF_LIFE_MS = 30 * 60 * 1000;
export const SITE_RECENT_SUCCESS_CONFIDENCE_SAMPLES = 12;
export const SITE_RECENT_SUCCESS_PRIOR_SUCCESSES = 1;
export const SITE_RECENT_SUCCESS_PRIOR_FAILURES = 1;

export type RecentOutcomeSnapshot = {
  successCount: number;
  failureCount: number;
  sampleCount: number;
  successRate: number;
  confidence: number;
};

export function fibonacciNumber(index: number): number {
  if (index <= 2) return 1;
  let prev = 1;
  let current = 1;
  for (let i = 3; i <= index; i += 1) {
    const next = prev + current;
    prev = current;
    current = next;
  }
  return current;
}

/**
 * Weighted-route failures use a Fibonacci backoff, but the resulting cooldown must stay
 * representable as a JavaScript Date for downstream `toISOString()` calls.
 */
export function resolveFailureBackoffSec(failCount?: number | null): number {
  const normalizedFailCount = Math.max(1, Math.trunc(failCount ?? 0));
  return Math.min(FAILURE_BACKOFF_BASE_SEC * fibonacciNumber(normalizedFailCount), MAX_FAILURE_BACKOFF_SEC);
}

export function clampFailureCooldownMs(cooldownMs: number, maxCooldownMs: number): number {
  const normalized = Math.max(0, Math.trunc(cooldownMs));
  const maxMs = Math.max(1_000, Math.trunc(maxCooldownMs));
  return Math.min(normalized, maxMs);
}

export function resolveEffectiveFailureCooldownMs(
  failCount: number | null | undefined,
  maxCooldownMs: number,
): number {
  return clampFailureCooldownMs(resolveFailureBackoffSec(failCount) * 1000, maxCooldownMs);
}

export function resolveRoundRobinCooldownSec(level: number): number {
  const normalizedLevel = Math.max(0, Math.min(ROUND_ROBIN_COOLDOWN_LEVELS_SEC.length - 1, Math.trunc(level)));
  return ROUND_ROBIN_COOLDOWN_LEVELS_SEC[normalizedLevel] ?? 0;
}

export function resolveSiteRuntimeBreakerMs(level: number): number {
  const normalizedLevel = Math.max(0, Math.min(SITE_RUNTIME_BREAKER_LEVELS_MS.length - 1, Math.trunc(level)));
  return SITE_RUNTIME_BREAKER_LEVELS_MS[normalizedLevel] ?? 0;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function isContributionCloseToBest(
  value: number,
  bestValue: number,
  ratio = STABLE_FIRST_SITE_SCORE_RATIO,
): boolean {
  if (bestValue <= 0) return true;
  return value >= (bestValue * ratio);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readFiniteInteger(value: unknown): number | null {
  const normalized = readFiniteNumber(value);
  return normalized == null ? null : Math.trunc(normalized);
}

export function readNullableTimestamp(value: unknown): number | null {
  const normalized = readFiniteInteger(value);
  if (normalized == null || normalized <= 0) return null;
  return normalized;
}

export function decayRecentOutcomeCount(value: number, elapsedMs: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (elapsedMs <= 0) return value;
  const decayFactor = Math.pow(0.5, elapsedMs / SITE_RECENT_OUTCOME_HALF_LIFE_MS);
  return value * decayFactor;
}

export function buildRecentOutcomeSnapshot(
  successCount: number,
  failureCount: number,
): RecentOutcomeSnapshot {
  const normalizedSuccessCount = Math.max(0, successCount);
  const normalizedFailureCount = Math.max(0, failureCount);
  const sampleCount = normalizedSuccessCount + normalizedFailureCount;
  const successRate = (
    normalizedSuccessCount + SITE_RECENT_SUCCESS_PRIOR_SUCCESSES
  ) / (
    sampleCount + SITE_RECENT_SUCCESS_PRIOR_SUCCESSES + SITE_RECENT_SUCCESS_PRIOR_FAILURES
  );
  return {
    successCount: normalizedSuccessCount,
    failureCount: normalizedFailureCount,
    sampleCount,
    successRate,
    confidence: clampNumber(sampleCount / SITE_RECENT_SUCCESS_CONFIDENCE_SAMPLES, 0, 1),
  };
}

export function blendRecentOutcomeSnapshots(
  globalSnapshot: RecentOutcomeSnapshot,
  modelSnapshot: RecentOutcomeSnapshot | null,
  modelWeight: number,
): RecentOutcomeSnapshot {
  if (!modelSnapshot || modelSnapshot.sampleCount <= 0) {
    return globalSnapshot;
  }
  const normalizedModelWeight = clampNumber(modelWeight, 0, 1);
  const globalWeight = 1 - normalizedModelWeight;
  return buildRecentOutcomeSnapshot(
    (globalSnapshot.successCount * globalWeight) + (modelSnapshot.successCount * normalizedModelWeight),
    (globalSnapshot.failureCount * globalWeight) + (modelSnapshot.failureCount * normalizedModelWeight),
  );
}
