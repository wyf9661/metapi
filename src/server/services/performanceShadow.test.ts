import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearPerformanceShadowMetrics,
  estimateFirstByteWindowMs,
  getPerformanceShadowMetrics,
  listPerformanceShadowMetricsByRouteId,
  listPerformanceShadowAttempts,
  performanceShadowConstants,
  recordPerformanceShadowAttempt,
  recordPerformanceShadowSample,
  resolveAdaptiveFirstByteFloorMs,
} from './performanceShadow.js';

describe('performanceShadow', () => {
  beforeEach(() => clearPerformanceShadowMetrics());

  it('isolates stream metrics by route, site, model, and modality', () => {
    recordPerformanceShadowSample({
      key: { routeId: 1, siteId: 2, modelName: 'GPT-5', isStream: true },
      latencyMs: 2_000,
      firstByteLatencyMs: 500,
      completionTokens: 150,
      nowMs: 10,
    });
    expect(getPerformanceShadowMetrics({
      routeId: 1, siteId: 2, modelName: 'gpt-5', isStream: true,
    }, 10)).toMatchObject({
      ttftEwmaMs: 500,
      tpsEwma: 100,
      e2eLatencyEwmaMs: 2_000,
      sampleCount: 1,
    });
    expect(getPerformanceShadowMetrics({
      routeId: 1, siteId: 2, modelName: 'gpt-5', isStream: false,
    }, 10)).toBeNull();
  });

  it('uses EWMA and protects TPS from missing or tiny usage samples', () => {
    recordPerformanceShadowSample({
      key: { routeId: 1, siteId: 2, modelName: 'gpt-5', isStream: true },
      latencyMs: 2_000,
      firstByteLatencyMs: 500,
      completionTokens: 150,
      nowMs: 10,
    });
    recordPerformanceShadowSample({
      key: { routeId: 1, siteId: 2, modelName: 'gpt-5', isStream: true },
      latencyMs: 3_000,
      firstByteLatencyMs: 1_000,
      completionTokens: 300,
      nowMs: 20,
    });
    expect(getPerformanceShadowMetrics({
      routeId: 1, siteId: 2, modelName: 'gpt-5', isStream: true,
    }, 20)).toMatchObject({
      ttftEwmaMs: 650,
      tpsEwma: 115,
      e2eLatencyEwmaMs: 2_300,
      sampleCount: 2,
    });

    recordPerformanceShadowSample({
      key: { routeId: 1, siteId: 2, modelName: 'gpt-5', isStream: true },
      latencyMs: 4_000,
      firstByteLatencyMs: 1_000,
      completionTokens: 1,
      nowMs: 30,
    });
    expect(getPerformanceShadowMetrics({
      routeId: 1, siteId: 2, modelName: 'gpt-5', isStream: true,
    }, 30)?.tpsEwma).toBe(115);
  });

  it('evicts expired and least-recent performance metrics', () => {
    for (let index = 0; index <= 5_000; index += 1) {
      recordPerformanceShadowSample({
        key: { routeId: index + 1, siteId: 1, modelName: `model-${index}`, isStream: false },
        latencyMs: 100,
        nowMs: index,
      });
    }
    expect(getPerformanceShadowMetrics({
      routeId: 1, siteId: 1, modelName: 'model-0', isStream: false,
    }, 5_000)).toBeNull();
    expect(getPerformanceShadowMetrics({
      routeId: 5_001, siteId: 1, modelName: 'model-5000', isStream: false,
    }, 5_000)).not.toBeNull();

    expect(getPerformanceShadowMetrics({
      routeId: 5_001, siteId: 1, modelName: 'model-5000', isStream: false,
    }, 5_000 + performanceShadowConstants.ttlMs + 1)).toBeNull();
  });

  it('lists performance metrics directly by route id', () => {
    recordPerformanceShadowSample({
      key: { routeId: 7, siteId: 2, modelName: 'model-a', isStream: false },
      latencyMs: 100,
    });
    recordPerformanceShadowSample({
      key: { routeId: 8, siteId: 3, modelName: 'model-b', isStream: false },
      latencyMs: 200,
    });
    expect(listPerformanceShadowMetricsByRouteId(7)).toHaveLength(1);
    expect(listPerformanceShadowMetricsByRouteId(7)[0]?.modelName).toBe('model-a');
  });

  it('records non-streaming E2E without fabricating TTFT or TPS', () => {
    recordPerformanceShadowSample({
      key: { routeId: 3, siteId: 4, modelName: 'model-x', isStream: false },
      latencyMs: 800,
      firstByteLatencyMs: 100,
      completionTokens: 200,
    });
    const metrics = getPerformanceShadowMetrics({
      routeId: 3, siteId: 4, modelName: 'model-x', isStream: false,
    });
    expect(metrics).toMatchObject({
      ttftEwmaMs: null,
      tpsEwma: null,
      e2eLatencyEwmaMs: 800,
    });
    expect(performanceShadowConstants.minTpsCompletionTokens).toBe(2);
  });
});

describe('adaptive first-byte floor', () => {
  const key = { routeId: 1, siteId: 2, modelName: 'jitter-site', isStream: true };
  const base = Date.parse('2026-10-26T10:00:00Z');

  function seed(
    steps: Array<{ outcome: 'success' | 'timeout'; ttftMs?: number; budgetMs?: number }>,
  ) {
    steps.forEach((step, index) => {
      recordPerformanceShadowAttempt({
        key,
        outcome: step.outcome,
        firstByteLatencyMs: step.ttftMs ?? null,
        budgetMs: step.budgetMs ?? null,
        nowMs: base + index * 1_000,
      });
    });
  }

  const floorOf = (floorMs: number, ceilingMs = 30_000) => resolveAdaptiveFirstByteFloorMs({
    attempts: listPerformanceShadowAttempts(key, base + 30_000),
    floorMs,
    ceilingMs,
  });

  beforeEach(() => clearPerformanceShadowMetrics());

  it('lifts the floor one rung above an isolated censored timeout', () => {
    seed([
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'timeout', budgetMs: 8_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
    ]);
    // The timeout is evidence the tail is >= 8s; one ladder rung above it.
    expect(floorOf(8_000)).toBe(12_000);
  });

  it('does not ratchet on a run of consecutive timeouts', () => {
    seed([
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'timeout', budgetMs: 8_000 },
      { outcome: 'timeout', budgetMs: 8_000 },
      { outcome: 'timeout', budgetMs: 8_000 },
      { outcome: 'timeout', budgetMs: 8_000 },
    ]);
    // Only the first timeout is isolated; a dead channel must not push the
    // window toward the ceiling where every failure waits longer.
    expect(floorOf(8_000)).toBe(12_000);
  });

  it('keeps the static floor for a fast, steady site', () => {
    seed(Array.from({ length: 10 }, () => ({ outcome: 'success' as const, ttftMs: 2_000 })));
    expect(floorOf(8_000)).toBe(8_000);
  });

  it('does not let an extreme success outlier lift the floor', () => {
    // A bimodal relay: 90% at 2s, one 45s outlier. The cost optimiser is
    // allowed to reject that tail deliberately; the floor must not pin it.
    seed([
      ...Array.from({ length: 9 }, () => ({ outcome: 'success' as const, ttftMs: 2_000 })),
      { outcome: 'success', ttftMs: 45_000 },
    ]);
    expect(floorOf(8_000)).toBe(8_000);
  });

  it('respects the ceiling and an empty history', () => {
    expect(floorOf(8_000, 10_000)).toBe(8_000);
    seed([
      { outcome: 'success', ttftMs: 1_000 },
      { outcome: 'timeout', budgetMs: 9_000 },
    ]);
    expect(floorOf(8_000, 10_000)).toBe(10_000);
  });

  it('returns a window above the old 8s floor for a jittery site', () => {
    seed([
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'timeout', budgetMs: 8_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
      { outcome: 'success', ttftMs: 2_000 },
    ]);
    const windowMs = estimateFirstByteWindowMs({
      key,
      floorMs: 8_000,
      ceilingMs: 30_000,
      nowMs: base + 30_000,
    });
    expect(windowMs).toBeGreaterThanOrEqual(12_000);
  });
});
