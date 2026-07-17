/**
 * Marketplace model throughput helpers.
 *
 * Goal: show a believable generation speed (token/s) on the model square.
 * Bad samples (first-byte nearly equal to total latency) previously produced
 * tens of thousands of t/s because generationMs collapsed to 1–3ms.
 */

export type ThroughputLogSample = {
  status?: string | null;
  latencyMs?: number | null;
  firstByteLatencyMs?: number | null;
  completionTokens?: number | null;
  isStream?: boolean | number | null;
};

export type ThroughputAggregate = {
  tokens: number;
  durationMs: number;
  sampleCount: number;
};

/** Hard ceiling for a single sample; real chat LLMs are far below this. */
export const MARKETPLACE_THROUGHPUT_MAX_TPS = 500;

/**
 * Minimum generation window when using post-TTFT duration.
 * Below this we treat first-byte as unreliable and fall back to full latency.
 */
export const MARKETPLACE_MIN_POST_TTFT_MS = 250;

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asPositiveInt(value: unknown): number | null {
  const n = asFiniteNumber(value);
  if (n == null) return null;
  const truncated = Math.trunc(n);
  return truncated > 0 ? truncated : null;
}

function isTruthyStreamFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/**
 * Resolve the generation duration used for throughput.
 * - Streaming + healthy post-TTFT window → latency - firstByte
 * - Otherwise → full request latency
 */
export function resolveMarketplaceGenerationMs(sample: ThroughputLogSample): number | null {
  const latencyMs = asFiniteNumber(sample.latencyMs);
  if (latencyMs == null || latencyMs <= 0) return null;

  const firstByteMs = asFiniteNumber(sample.firstByteLatencyMs);
  if (
    isTruthyStreamFlag(sample.isStream)
    && firstByteMs != null
    && firstByteMs >= 0
    && latencyMs > firstByteMs
  ) {
    const postTtftMs = latencyMs - firstByteMs;
    // Only trust post-TTFT when the generation phase is long enough.
    // Many gateways stamp first_byte almost at response end for buffered/stream-close cases.
    if (postTtftMs >= MARKETPLACE_MIN_POST_TTFT_MS) {
      return postTtftMs;
    }
  }

  return latencyMs;
}

export function computeSampleThroughputTps(sample: ThroughputLogSample): number | null {
  if ((sample.status || '').toLowerCase() !== 'success') return null;
  const completionTokens = asPositiveInt(sample.completionTokens);
  if (completionTokens == null) return null;
  const generationMs = resolveMarketplaceGenerationMs(sample);
  if (generationMs == null || generationMs <= 0) return null;

  const tps = completionTokens / (generationMs / 1000);
  if (!Number.isFinite(tps) || tps <= 0) return null;
  if (tps > MARKETPLACE_THROUGHPUT_MAX_TPS) return null;
  return tps;
}

export function createThroughputAggregate(): ThroughputAggregate {
  return { tokens: 0, durationMs: 0, sampleCount: 0 };
}

/** Token-weighted accumulation: total_tokens / total_generation_seconds. */
export function accumulateThroughputSample(
  agg: ThroughputAggregate,
  sample: ThroughputLogSample,
): void {
  if ((sample.status || '').toLowerCase() !== 'success') return;
  const completionTokens = asPositiveInt(sample.completionTokens);
  if (completionTokens == null) return;
  const generationMs = resolveMarketplaceGenerationMs(sample);
  if (generationMs == null || generationMs <= 0) return;

  const tps = completionTokens / (generationMs / 1000);
  if (!Number.isFinite(tps) || tps <= 0 || tps > MARKETPLACE_THROUGHPUT_MAX_TPS) {
    return;
  }

  agg.tokens += completionTokens;
  agg.durationMs += generationMs;
  agg.sampleCount += 1;
}

export function finalizeThroughputTps(agg: ThroughputAggregate | null | undefined): number | null {
  if (!agg || agg.sampleCount <= 0 || agg.tokens <= 0 || agg.durationMs <= 0) return null;
  const tps = agg.tokens / (agg.durationMs / 1000);
  if (!Number.isFinite(tps) || tps <= 0) return null;
  // Round to 1 decimal for UI parity with previous field.
  return Math.round(Math.min(tps, MARKETPLACE_THROUGHPUT_MAX_TPS) * 10) / 10;
}

export function getThroughputSampleCount(agg: ThroughputAggregate | null | undefined): number {
  if (!agg || !Number.isFinite(agg.sampleCount) || agg.sampleCount <= 0) return 0;
  return Math.trunc(agg.sampleCount);
}

/** Whether the sample set is too small to treat throughput as reliable. */
export function isThroughputSampleSparse(sampleCount: number, minSamples = 5): boolean {
  return !Number.isFinite(sampleCount) || sampleCount < minSamples;
}
