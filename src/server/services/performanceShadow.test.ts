import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearPerformanceShadowMetrics,
  getPerformanceShadowMetrics,
  listPerformanceShadowMetricsByRouteId,
  performanceShadowConstants,
  recordPerformanceShadowSample,
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
