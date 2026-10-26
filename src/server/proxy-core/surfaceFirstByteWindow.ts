import { config } from '../config.js';
import {
  PROXY_FIRST_BYTE_ADAPTIVE_MIN_SAMPLES,
  PROXY_FIRST_BYTE_WINDOW_FLOOR_MS,
  resolveProxyChannelFirstByteTimeoutMs,
} from '../services/proxyChannelRetry.js';
import {
  estimateFirstByteWindowMs,
  getPerformanceShadowMetrics,
} from '../services/performanceShadow.js';

/**
 * The first-byte window for one upstream attempt — decided ONCE, for every
 * downstream surface.
 *
 * The window is a property of the upstream (site + model + whether the answer
 * streams), not of the protocol the client happened to speak. Wiring the
 * decision into each surface duplicated it (chat, responses) and silently
 * skipped the third (gemini native), so the same site answered under a learned
 * window through one door and under the static configured ceiling through
 * another. Anything that opens an upstream attempt must come through here.
 *
 * Order of evidence, strongest first:
 *  1. raw attempt series (successes + censored timeouts) — the survival-curve
 *     estimator, which also carries the escalation/hold policy;
 *  2. the per-site EWMA, once enough samples exist (same bucket);
 *  3. the static configured ceiling.
 *
 * Non-streaming attempts deliberately keep the static ceiling for now: their
 * "first byte" is the whole body, a different distribution, and folding them
 * into the streaming bucket would corrupt both. That decision is separate from
 * this unification.
 */
export function resolveSurfaceFirstByteWindowMs(input: {
  routeId?: number | null;
  siteId?: number | null;
  modelName: string;
  isStream?: boolean | null;
  retryCount?: number | null;
  nowMs?: number;
}): number {
  const retryCount = Math.max(0, Math.trunc(input.retryCount ?? 0));
  const modelName = typeof input.modelName === 'string' ? input.modelName : '';
  const configuredCeilingMs = Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000));
  const siteId = Math.trunc(input.siteId ?? 0);
  if (input.isStream !== true || configuredCeilingMs <= 0 || siteId <= 0 || !modelName) {
    return resolveProxyChannelFirstByteTimeoutMs(retryCount);
  }

  const key = {
    routeId: input.routeId ?? null,
    siteId,
    modelName,
    isStream: true,
  };
  const learnedMs = estimateFirstByteWindowMs({
    key,
    floorMs: PROXY_FIRST_BYTE_WINDOW_FLOOR_MS,
    ceilingMs: configuredCeilingMs,
    nowMs: input.nowMs,
  });
  if (learnedMs !== null) return learnedMs;

  // Too few raw attempts yet (a low-traffic bucket never accumulates the eight
  // the estimator needs). Fall back to the EWMA rule — still per site, still
  // streaming-only — before the configured ceiling.
  const metrics = getPerformanceShadowMetrics(key, input.nowMs);
  const adaptiveTtftMs = metrics
    && metrics.sampleCount >= PROXY_FIRST_BYTE_ADAPTIVE_MIN_SAMPLES
    ? metrics.ttftEwmaMs
    : null;
  return resolveProxyChannelFirstByteTimeoutMs(retryCount, adaptiveTtftMs);
}
