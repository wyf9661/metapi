import { describe, expect, it } from 'vitest';
import {
  normalizeClientConfidence,
  normalizeDashboardView,
  normalizeProxyLogOffset,
  normalizeProxyLogPageSize,
  normalizeProxyLogSiteId,
  parseBooleanFlag,
  parseDownstreamKeyTags,
  roundPercent,
} from './stats.pure.js';

describe('stats.pure', () => {
  it('parses boolean flags', () => {
    expect(parseBooleanFlag('1')).toBe(true);
    expect(parseBooleanFlag('true')).toBe(true);
    expect(parseBooleanFlag('YES')).toBe(true);
    expect(parseBooleanFlag('0')).toBe(false);
    expect(parseBooleanFlag(undefined)).toBe(false);
  });

  it('normalizes dashboard / proxy-logs views', () => {
    expect(normalizeDashboardView('summary')).toBe('summary');
    expect(normalizeDashboardView('insights')).toBe('insights');
    expect(normalizeDashboardView('garbage')).toBe('full');
    expect(normalizeProxyLogPageSize('25')).toBe(25);
    expect(normalizeProxyLogPageSize('999')).toBe(100);
    expect(normalizeProxyLogPageSize('0')).toBe(1);
    expect(normalizeProxyLogPageSize(undefined)).toBe(50);
    expect(normalizeProxyLogOffset('-5')).toBe(0);
    expect(normalizeProxyLogSiteId('12')).toBe(12);
    expect(normalizeProxyLogSiteId('abc')).toBeNull();
    expect(normalizeProxyLogSiteId('0')).toBeNull();
  });

  it('dedupes and trims downstream key tags', () => {
    expect(parseDownstreamKeyTags('[" a ", "b", "a"]')).toEqual(['a', 'b']);
    expect(parseDownstreamKeyTags('not json')).toEqual([]);
    expect(parseDownstreamKeyTags('{"a":1}')).toEqual([]);
    expect(parseDownstreamKeyTags(undefined)).toEqual([]);
  });

  it('normalizes client confidence and rounds percents', () => {
    expect(normalizeClientConfidence('EXACT')).toBe('exact');
    expect(normalizeClientConfidence('heuristic')).toBe('heuristic');
    expect(normalizeClientConfidence('nope')).toBeNull();
    expect(roundPercent(12.34)).toBe(12.3);
    expect(roundPercent(null)).toBeNull();
    expect(roundPercent(Number.NaN)).toBeNull();
  });
});

describe('mapWithConcurrency', () => {
  it('maps all items preserving order', async () => {
    const { mapWithConcurrency } = await import('./stats.pure.js');
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('never exceeds the concurrency bound', async () => {
    const { mapWithConcurrency } = await import('./stats.pure.js');
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles empty input', async () => {
    const { mapWithConcurrency } = await import('./stats.pure.js');
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('clamps invalid concurrency to at least 1', async () => {
    const { mapWithConcurrency } = await import('./stats.pure.js');
    const out = await mapWithConcurrency([1, 2], 0, async (n) => n);
    expect(out).toEqual([1, 2]);
  });
});
