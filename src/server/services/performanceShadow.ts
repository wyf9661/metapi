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
const metricsByKey = new Map<string, PerformanceShadowMetrics>();

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
  metricsByKey.set(key, next);
  return { ...next };
}

export function getPerformanceShadowMetrics(key: PerformanceShadowKey): PerformanceShadowMetrics | null {
  const value = metricsByKey.get(buildPerformanceShadowKey(key));
  return value ? { ...value } : null;
}

export function listPerformanceShadowMetrics(): PerformanceShadowMetrics[] {
  return [...metricsByKey.values()].map((value) => ({ ...value }));
}

export function clearPerformanceShadowMetrics(): void {
  metricsByKey.clear();
}

export const performanceShadowConstants = {
  defaultAlpha: DEFAULT_ALPHA,
  minTpsCompletionTokens: MIN_TPS_COMPLETION_TOKENS,
};
