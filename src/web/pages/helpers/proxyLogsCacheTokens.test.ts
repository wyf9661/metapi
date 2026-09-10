import { describe, expect, it } from 'vitest';
import {
  formatProxyLogTokenPair,
  formatProxyLogUseTime,
  formatTokensPerSecond,
  getProxyLogFirstTokenVariant,
  getProxyLogResponseTimeVariant,
  getProxyLogThroughputVariant,
  getProxyLogTimeVariant,
  proxyLogKeyChipColors,
  proxyLogKeyHue,
  proxyLogRetryColor,
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
    expect(formatProxyLogTokenPair(null, 12)).toBe('- / 12');
  });

  it('shows a dash pair for failed calls instead of 0 / --', () => {
    expect(formatProxyLogTokenPair(0, null)).toBe('- / -');
    expect(formatProxyLogTokenPair(null, null)).toBe('- / -');
    expect(formatProxyLogTokenPair(0, 0)).toBe('- / -');
  });
});

describe('timing column (ported from NewAPI)', () => {
  it('scales first-token and duration variants with the NewAPI thresholds', () => {
    expect(getProxyLogFirstTokenVariant(4.9)).toBe('success');
    expect(getProxyLogFirstTokenVariant(5)).toBe('warning');
    expect(getProxyLogFirstTokenVariant(10)).toBe('danger');
    expect(getProxyLogTimeVariant(9.9)).toBe('success');
    expect(getProxyLogTimeVariant(10)).toBe('warning');
    expect(getProxyLogTimeVariant(30)).toBe('danger');
  });

  it('judges duration by throughput once the output is measurable', () => {
    // 230 tokens in 19.0s ≈ 12 t/s → danger, even though 19s alone is warning.
    expect(getProxyLogResponseTimeVariant(19.033, 230)).toBe('danger');
    // Under 100 completion tokens the plain duration scale applies.
    expect(getProxyLogResponseTimeVariant(19.033, 12)).toBe('warning');
    expect(getProxyLogThroughputVariant(30)).toBe('success');
    expect(getProxyLogThroughputVariant(15)).toBe('warning');
  });

  it('formats the duration the NewAPI way', () => {
    expect(formatProxyLogUseTime(0.84)).toBe('840ms');
    expect(formatProxyLogUseTime(0.022)).toBe('22ms');
    expect(formatProxyLogUseTime(19.033)).toBe('19.0s');
    expect(formatProxyLogUseTime(65)).toBe('1m 5s');
    expect(formatProxyLogUseTime(Number.NaN)).toBe('--');
  });
});

describe('retry column', () => {
  it('deepens the number colour with the retry count', () => {
    expect(proxyLogRetryColor(0)).toBe('var(--color-text-secondary)');
    expect(proxyLogRetryColor(1)).toBe('var(--color-warning)');
    expect(proxyLogRetryColor(2)).toBe('color-mix(in srgb, var(--color-warning) 45%, var(--color-danger))');
    expect(proxyLogRetryColor(3)).toBe('var(--color-danger)');
    expect(proxyLogRetryColor(null)).toBe('var(--color-text-secondary)');
  });
});

describe('key chip colours', () => {
  it('derives a stable muted hue from the key name', () => {
    const first = proxyLogKeyHue('windows');
    expect(proxyLogKeyHue('windows')).toBe(first);
    expect([175, 190, 205, 215, 230, 250, 265, 285, 300, 330, 20, 45]).toContain(first);
    // Different names are allowed to collide, but the palette must not collapse.
    const hues = new Set(['windows', 'ubuntu', '移动端灰度', 'ci', 'dev'].map(proxyLogKeyHue));
    expect(hues.size).toBeGreaterThan(1);
  });

  it('mixes the hue into the grey chip base', () => {
    const colors = proxyLogKeyChipColors('windows');
    expect(colors.background).toContain('var(--color-bg-subtle)');
    expect(colors.border).toContain('var(--color-border)');
    expect(colors.background).toContain(`hsl(${proxyLogKeyHue('windows')} 60% 50%)`);
  });
});

describe('throughput display', () => {
  it('reports completion tokens per second with the t/s unit', () => {
    // Generation speed only — a 50k cached prefix must not inflate the rate
    // (it shows up as low latency instead).
    expect(formatTokensPerSecond(2300, 10000)).toBe('230 t/s');
    expect(formatTokensPerSecond(230, 19033)).toBe('12 t/s');
  });

  it('returns null without usable tokens or latency', () => {
    expect(formatTokensPerSecond(0, 1000)).toBeNull();
    expect(formatTokensPerSecond(100, 0)).toBeNull();
    expect(formatTokensPerSecond(null, null)).toBeNull();
  });
});
