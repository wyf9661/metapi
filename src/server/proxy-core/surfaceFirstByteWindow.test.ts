import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import {
  clearPerformanceShadowMetrics,
  recordPerformanceShadowAttempt,
  recordPerformanceShadowSample,
} from '../services/performanceShadow.js';
import { resolveSurfaceFirstByteWindowMs } from './surfaceFirstByteWindow.js';

const ORIGINAL_TIMEOUT_SEC = (config as any).proxyFirstByteTimeoutSec;
const SITE_ID = 316;
const ROUTE_ID = 7;
const MODEL = 'deepseek-v4.1-flash';

function resolve(overrides: Partial<Parameters<typeof resolveSurfaceFirstByteWindowMs>[0]> = {}) {
  return resolveSurfaceFirstByteWindowMs({
    routeId: ROUTE_ID,
    siteId: SITE_ID,
    modelName: MODEL,
    isStream: true,
    retryCount: 0,
    ...overrides,
  });
}

describe('resolveSurfaceFirstByteWindowMs', () => {
  beforeEach(() => {
    clearPerformanceShadowMetrics();
    (config as any).proxyFirstByteTimeoutSec = 120;
  });

  afterEach(() => {
    clearPerformanceShadowMetrics();
    (config as any).proxyFirstByteTimeoutSec = ORIGINAL_TIMEOUT_SEC;
  });

  // The gemini-native door used to reach this function with isStream=false on
  // explain-style actions; a non-stream "first byte" is the whole body, so it
  // must keep the static ceiling rather than inherit the streaming bucket.
  it('keeps the static ceiling for non-streaming attempts', () => {
    expect(resolve({ isStream: false })).toBe(120_000);
  });

  it('returns 0 when the operator disabled the first-byte timeout', () => {
    (config as any).proxyFirstByteTimeoutSec = 0;
    expect(resolve()).toBe(0);
  });

  it('falls back to the configured ceiling when nothing has been measured', () => {
    expect(resolve()).toBe(120_000);
  });

  it('prefers the survival-curve window once enough attempts exist', () => {
    for (let i = 0; i < 8; i += 1) {
      recordPerformanceShadowAttempt({
        key: { routeId: ROUTE_ID, siteId: SITE_ID, modelName: MODEL, isStream: true },
        outcome: 'success',
        firstByteLatencyMs: 2_000,
      });
    }
    // Learned floor (8s), not the 120s configured ceiling: the point is that the
    // decision came from the attempts, whatever the exact value.
    expect(resolve()).toBe(8_000);
  });

  it('uses the per-site EWMA when the raw series is still too short', () => {
    for (let i = 0; i < 5; i += 1) {
      recordPerformanceShadowSample({
        key: { routeId: ROUTE_ID, siteId: SITE_ID, modelName: MODEL, isStream: true },
        latencyMs: 9_000,
        firstByteLatencyMs: 6_000,
        completionTokens: 20,
      });
    }
    // 5 x 6s = 30s, clamped to [30s, ceiling].
    expect(resolve()).toBe(30_000);
  });

  it('does not read another site bucket', () => {
    for (let i = 0; i < 10; i += 1) {
      recordPerformanceShadowAttempt({
        key: { routeId: ROUTE_ID, siteId: SITE_ID + 1, modelName: MODEL, isStream: true },
        outcome: 'success',
        firstByteLatencyMs: 2_000,
      });
    }
    expect(resolve()).toBe(120_000);
  });
});
