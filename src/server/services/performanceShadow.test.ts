import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearPerformanceShadowMetrics,
  getPerformanceShadowMetrics,
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
    })).toMatchObject({
      ttftEwmaMs: 500,
      tpsEwma: 100,
      e2eLatencyEwmaMs: 2_000,
      sampleCount: 1,
    });
    expect(getPerformanceShadowMetrics({
      routeId: 1, siteId: 2, modelName: 'gpt-5', isStream: false,
    })).toBeNull();
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
    })).toMatchObject({
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
    });
    expect(getPerformanceShadowMetrics({
      routeId: 1, siteId: 2, modelName: 'gpt-5', isStream: true,
    })?.tpsEwma).toBe(115);
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
