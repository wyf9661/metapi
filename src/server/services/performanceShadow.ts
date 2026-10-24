export type PerformanceShadowKey = {
  routeId?: number | null;
  siteId: number;
  modelName: string;
  isStream: boolean;
};

export type PerformanceShadowMetrics = {
  key: string;
  routeId: number | null;
  siteId: number;
  modelName: string;
  isStream: boolean;
  ttftEwmaMs: number | null;
  tpsEwma: number | null;
  e2eLatencyEwmaMs: number | null;
  sampleCount: number;
  updatedAtMs: number;
};

const DEFAULT_ALPHA = 0.3;
const MIN_TPS_COMPLETION_TOKENS = 2;
const PERFORMANCE_SHADOW_TTL_MS = 72 * 60 * 60 * 1000;
const PERFORMANCE_SHADOW_MAX_ENTRIES = 5_000;
const metricsByKey = new Map<string, PerformanceShadowMetrics>();

/**
 * Raw attempt history per key. The EWMA above is a single number and cannot
 * describe a relay that fans out to several internal upstreams (one key, many
 * backends): its first-byte distribution is a mixture with two or three modes
 * and a gap between them, so any mean lands in the gap and fits nothing.
 *
 * These attempts keep enough shape to build the survival curve
 * `S(t) = P(first byte within t)`, including CENSORED attempts: a timeout at
 * window W tells us `T >= W`, which is exactly what the curve needs. Waiting
 * past the window to learn the exact value would only burn the upstream's
 * concurrency slot without changing the decision.
 */
export type PerformanceShadowOutcome = 'success' | 'timeout' | 'error';

export type PerformanceShadowAttempt = {
  atMs: number;
  outcome: PerformanceShadowOutcome;
  /** Success only: observed time to first byte. */
  firstByteLatencyMs: number | null;
  /** Timeout only: the window that expired, i.e. the censoring point. */
  budgetMs: number | null;
};

const attemptsByKey = new Map<string, PerformanceShadowAttempt[]>();
/** Attempts kept per key: enough shape, cheap to scan on every request. */
const ATTEMPT_WINDOW_MAX = 60;
const ATTEMPT_TTL_MS = 6 * 60 * 60 * 1000;
/** Samples required before the window estimator is allowed to override. */
export const FIRST_BYTE_WINDOW_MIN_SAMPLES = 8;

function sweepAttempts(nowMs = Date.now()): void {
  const cutoff = nowMs - ATTEMPT_TTL_MS;
  for (const [key, list] of attemptsByKey.entries()) {
    const kept = list.filter((attempt) => attempt.atMs >= cutoff);
    if (kept.length === 0) attemptsByKey.delete(key);
    else if (kept.length !== list.length) attemptsByKey.set(key, kept);
  }
}

/** Record one attempt for the survival curve (success, censored timeout, or error). */
export function recordPerformanceShadowAttempt(input: {
  key: PerformanceShadowKey;
  outcome: PerformanceShadowOutcome;
  firstByteLatencyMs?: number | null;
  budgetMs?: number | null;
  nowMs?: number;
}): void {
  const siteId = Math.trunc(input.key.siteId);
  const modelName = normalizeModelName(input.key.modelName);
  if (siteId <= 0 || !modelName) return;
  const atMs = input.nowMs ?? Date.now();
  const firstByteLatencyMs = input.outcome === 'success'
    && Number.isFinite(input.firstByteLatencyMs)
    ? Math.max(0, Number(input.firstByteLatencyMs))
    : null;
  // An attempt without a usable measurement teaches nothing.
  if (input.outcome === 'success' && firstByteLatencyMs === null) return;
  const budgetMs = Number.isFinite(input.budgetMs) ? Math.max(0, Number(input.budgetMs)) : null;
  if (input.outcome === 'timeout' && (budgetMs === null || budgetMs <= 0)) return;

  const key = buildPerformanceShadowKey({ ...input.key, siteId, modelName });
  const list = attemptsByKey.get(key) ?? [];
  list.push({ atMs, outcome: input.outcome, firstByteLatencyMs, budgetMs });
  if (list.length > ATTEMPT_WINDOW_MAX) list.splice(0, list.length - ATTEMPT_WINDOW_MAX);
  attemptsByKey.set(key, list);
  sweepAttempts(atMs);
}

export function listPerformanceShadowAttempts(
  key: PerformanceShadowKey,
  nowMs = Date.now(),
): PerformanceShadowAttempt[] {
  sweepAttempts(nowMs);
  const storeKey = buildPerformanceShadowKey(key);
  return (attemptsByKey.get(storeKey) ?? []).map((attempt) => ({ ...attempt }));
}

/**
 * Pick the first-byte window that minimises **time per usable answer**:
 *
 *   cost(W) = E[min(T, W)] / P(T <= W)
 *
 * Waiting longer than the mixture's fast mode buys very little success while
 * paying the full wait on every attempt, so this metric usually prefers a
 * SHORTER window than a mean-based heuristic — and it needs no multiplier
 * guess, so it can never overshoot the configured ceiling by construction.
 *
 * `currentMs` adds hysteresis: keep the incumbent unless the alternative is
 * measurably better, so the window does not oscillate request to request.
 */
export function estimateFirstByteWindowMs(input: {
  key: PerformanceShadowKey;
  floorMs: number;
  ceilingMs: number;
  currentMs?: number | null;
  minSamples?: number;
  nowMs?: number;
}): number | null {
  const ceilingMs = Math.trunc(input.ceilingMs);
  if (!Number.isFinite(ceilingMs) || ceilingMs <= 0) return null;
  const floorMs = Math.max(0, Math.min(Math.trunc(input.floorMs), ceilingMs));
  const minSamples = Math.max(2, Math.trunc(input.minSamples ?? FIRST_BYTE_WINDOW_MIN_SAMPLES));
  const attempts = listPerformanceShadowAttempts(input.key, input.nowMs);
  if (attempts.length < minSamples) return null;

  const n = attempts.length;
  const points = new Set<number>([floorMs, ceilingMs]);
  for (const attempt of attempts) {
    if (attempt.outcome === 'success' && attempt.firstByteLatencyMs !== null) {
      points.add(Math.min(ceilingMs, Math.max(floorMs, Math.round(attempt.firstByteLatencyMs))));
    }
  }
  const candidates = [...points].sort((a, b) => a - b);

  const score = (windowMs: number): number => {
    let successes = 0;
    let totalCost = 0;
    for (const attempt of attempts) {
      if (attempt.outcome === 'success'
        && attempt.firstByteLatencyMs !== null
        && attempt.firstByteLatencyMs <= windowMs) {
        successes += 1;
        totalCost += attempt.firstByteLatencyMs;
      } else {
        // Timed out inside this window, or failed/was censored: the attempt
        // still costs the whole window in wall-clock terms.
        totalCost += windowMs;
      }
    }
    if (successes <= 0) return Number.POSITIVE_INFINITY;
    return (totalCost / n) / (successes / n);
  };

  let bestMs = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const value = score(candidate);
    if (value < bestScore - 1e-9) {
      bestScore = value;
      bestMs = candidate;
    }
  }
  // No window produced a single success: the site is not merely slow, it is
  // failing. Stay out of the way and let the caller keep its configured value.
  if (!Number.isFinite(bestScore)) return null;

  const currentMs = input.currentMs;
  if (typeof currentMs === 'number' && Number.isFinite(currentMs) && currentMs > 0) {
    const currentClamped = Math.min(ceilingMs, Math.max(floorMs, Math.trunc(currentMs)));
    const currentScore = score(currentClamped);
    // 15% improvement needed to move; avoids flapping on noisy samples.
    if (Number.isFinite(currentScore) && bestScore > currentScore * 0.85) return currentClamped;
  }
  return Math.min(ceilingMs, Math.max(floorMs, bestMs));
}

function sweepPerformanceShadowMetrics(nowMs = Date.now()): void {
  const cutoff = nowMs - PERFORMANCE_SHADOW_TTL_MS;
  for (const [key, value] of metricsByKey.entries()) {
    if (value.updatedAtMs < cutoff) metricsByKey.delete(key);
  }
  while (metricsByKey.size > PERFORMANCE_SHADOW_MAX_ENTRIES) {
    const oldestKey = metricsByKey.keys().next().value;
    if (!oldestKey) break;
    metricsByKey.delete(oldestKey);
  }
}

function normalizeModelName(modelName: string): string {
  return modelName.trim().toLowerCase();
}

export function buildPerformanceShadowKey(input: PerformanceShadowKey): string {
  const routeId = Number.isFinite(input.routeId) && (input.routeId ?? 0) > 0
    ? Math.trunc(input.routeId as number)
    : 0;
  return `${routeId}:${Math.trunc(input.siteId)}:${normalizeModelName(input.modelName)}:${input.isStream ? 'stream' : 'nonstream'}`;
}

function updateEwma(previous: number | null, sample: number | null, alpha: number): number | null {
  if (sample === null || !Number.isFinite(sample) || sample < 0) return previous;
  if (previous === null) return sample;
  return (alpha * sample) + ((1 - alpha) * previous);
}

export function recordPerformanceShadowSample(input: {
  key: PerformanceShadowKey;
  latencyMs: number;
  firstByteLatencyMs?: number | null;
  completionTokens?: number | null;
  nowMs?: number;
  alpha?: number;
}): PerformanceShadowMetrics | null {
  const siteId = Math.trunc(input.key.siteId);
  const modelName = normalizeModelName(input.key.modelName);
  const latencyMs = Number(input.latencyMs);
  if (siteId <= 0 || !modelName || !Number.isFinite(latencyMs) || latencyMs < 0) return null;

  const alpha = Math.min(1, Math.max(0.01, Number(input.alpha ?? DEFAULT_ALPHA)));
  const key = buildPerformanceShadowKey({ ...input.key, siteId, modelName });
  const previous = metricsByKey.get(key);
  const isStream = input.key.isStream;
  const firstByteLatencyMs = isStream && Number.isFinite(input.firstByteLatencyMs)
    ? Math.max(0, Number(input.firstByteLatencyMs))
    : null;
  const completionTokens = Number(input.completionTokens);
  const tps = isStream
    && firstByteLatencyMs !== null
    && Number.isFinite(completionTokens)
    && completionTokens >= MIN_TPS_COMPLETION_TOKENS
    && latencyMs > firstByteLatencyMs
    ? (completionTokens / ((latencyMs - firstByteLatencyMs) / 1000))
    : null;
  const next: PerformanceShadowMetrics = {
    key,
    routeId: Number.isFinite(input.key.routeId) && (input.key.routeId ?? 0) > 0
      ? Math.trunc(input.key.routeId as number)
      : null,
    siteId,
    modelName,
    isStream,
    ttftEwmaMs: updateEwma(previous?.ttftEwmaMs ?? null, firstByteLatencyMs, alpha),
    tpsEwma: updateEwma(previous?.tpsEwma ?? null, tps, alpha),
    e2eLatencyEwmaMs: updateEwma(previous?.e2eLatencyEwmaMs ?? null, latencyMs, alpha),
    sampleCount: (previous?.sampleCount ?? 0) + 1,
    updatedAtMs: input.nowMs ?? Date.now(),
  };
  metricsByKey.delete(key);
  metricsByKey.set(key, next);
  sweepPerformanceShadowMetrics(next.updatedAtMs);
  return { ...next };
}

export function getPerformanceShadowMetrics(key: PerformanceShadowKey, nowMs = Date.now()): PerformanceShadowMetrics | null {
  sweepPerformanceShadowMetrics(nowMs);
  const storeKey = buildPerformanceShadowKey(key);
  const value = metricsByKey.get(storeKey);
  if (value) {
    metricsByKey.delete(storeKey);
    metricsByKey.set(storeKey, value);
  }
  return value ? { ...value } : null;
}


export function listPerformanceShadowMetricsByRouteId(routeId: number, nowMs = Date.now()): PerformanceShadowMetrics[] {
  sweepPerformanceShadowMetrics(nowMs);
  const normalizedRouteId = Math.trunc(routeId);
  return [...metricsByKey.values()]
    .filter((value) => value.routeId === normalizedRouteId)
    .map((value) => ({ ...value }));
}

export function clearPerformanceShadowMetrics(): void {
  metricsByKey.clear();
  attemptsByKey.clear();
}

export const performanceShadowConstants = {
  defaultAlpha: DEFAULT_ALPHA,
  minTpsCompletionTokens: MIN_TPS_COMPLETION_TOKENS,
  ttlMs: PERFORMANCE_SHADOW_TTL_MS,
  maxEntries: PERFORMANCE_SHADOW_MAX_ENTRIES,
};
