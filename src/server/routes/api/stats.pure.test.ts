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
