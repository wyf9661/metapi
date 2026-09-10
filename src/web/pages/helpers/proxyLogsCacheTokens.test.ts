import { describe, expect, it } from 'vitest';
import {
  formatProxyLogTokenPair,
  formatTokensPerSecond,
  resolveProxyLogInputTokens,
} from './proxyLogsHelpers.js';

describe('usage log cache-aware token display', () => {
  it('keeps prompt_tokens as-is when the upstream already includes the cache', () => {
    expect(resolveProxyLogInputTokens({
      promptTokens: 20000,
      cacheReadTokens: 15000,
      cacheCreationTokens: 0,
    })).toBe(20000);
  });

  it('adds the cache back when the upstream reports input without it', () => {
    // Observed production shape: prompt_tokens=3 with cache_read=50483
    // (promptTokensIncludeCache=false) — the plain prompt value is not the
    // real input size.
    expect(resolveProxyLogInputTokens({
      promptTokens: 3,
      cacheReadTokens: 50483,
      cacheCreationTokens: 181,
    })).toBe(50667);
  });

  it('falls back to the raw prompt when no cache tokens are present', () => {
    expect(resolveProxyLogInputTokens({ promptTokens: 1234 })).toBe(1234);
    expect(resolveProxyLogInputTokens({ promptTokens: null, cacheReadTokens: 0 })).toBe(0);
  });

  it('formats the merged cell as input / output', () => {
    expect(formatProxyLogTokenPair(50667, 230)).toBe('50,667 / 230');
    expect(formatProxyLogTokenPair(null, 12)).toBe('-- / 12');
  });
});

describe('throughput display', () => {
  it('reports tokens per second with the t/s unit', () => {
    expect(formatTokensPerSecond(2300, 10000)).toBe('230 t/s');
    expect(formatTokensPerSecond(50716, 19033)).toBe('2665 t/s');
  });

  it('returns null without usable tokens or latency', () => {
    expect(formatTokensPerSecond(0, 1000)).toBeNull();
    expect(formatTokensPerSecond(100, 0)).toBeNull();
    expect(formatTokensPerSecond(null, null)).toBeNull();
  });
});
