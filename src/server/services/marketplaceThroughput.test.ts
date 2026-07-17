import { describe, expect, it } from 'vitest';
import {
  accumulateThroughputSample,
  computeSampleThroughputTps,
  createThroughputAggregate,
  finalizeThroughputTps,
  resolveMarketplaceGenerationMs,
} from './marketplaceThroughput.js';

describe('marketplaceThroughput', () => {
  it('uses full latency when first-byte nearly equals total latency', () => {
    // The old formula used generationMs=3 and produced ~1.3M t/s.
    expect(resolveMarketplaceGenerationMs({
      latencyMs: 62992,
      firstByteLatencyMs: 62989,
      isStream: false,
    })).toBe(62992);

    const tps = computeSampleThroughputTps({
      status: 'success',
      latencyMs: 62992,
      firstByteLatencyMs: 62989,
      completionTokens: 4096,
      isStream: false,
    });
    expect(tps).not.toBeNull();
    expect(tps!).toBeLessThan(100);
    expect(tps!).toBeCloseTo(4096 / (62992 / 1000), 1);
  });

  it('uses post-TTFT window for healthy streaming samples', () => {
    expect(resolveMarketplaceGenerationMs({
      latencyMs: 5000,
      firstByteLatencyMs: 1000,
      isStream: true,
    })).toBe(4000);

    const tps = computeSampleThroughputTps({
      status: 'success',
      latencyMs: 5000,
      firstByteLatencyMs: 1000,
      completionTokens: 800,
      isStream: true,
    });
    expect(tps).toBeCloseTo(200, 1);
  });

  it('rejects absurd samples above the marketplace ceiling', () => {
    expect(computeSampleThroughputTps({
      status: 'success',
      latencyMs: 10,
      firstByteLatencyMs: 0,
      completionTokens: 5000,
      isStream: true,
    })).toBeNull();
  });

  it('aggregates by total tokens / total generation time (token-weighted)', () => {
    const agg = createThroughputAggregate();
    // small request: 100 tokens in 2s => 50 t/s
    accumulateThroughputSample(agg, {
      status: 'success',
      latencyMs: 2000,
      completionTokens: 100,
      isStream: false,
    });
    // large request: 900 tokens in 3s => 300 t/s
    accumulateThroughputSample(agg, {
      status: 'success',
      latencyMs: 3000,
      completionTokens: 900,
      isStream: false,
    });
    // token-weighted: 1000 tokens / 5s = 200 t/s
    // simple average of per-request tps would be 175
    expect(finalizeThroughputTps(agg)).toBe(200);
  });

  it('ignores collapsed post-TTFT windows under 250ms', () => {
    expect(resolveMarketplaceGenerationMs({
      latencyMs: 10000,
      firstByteLatencyMs: 9980,
      isStream: true,
    })).toBe(10000);
  });
});
