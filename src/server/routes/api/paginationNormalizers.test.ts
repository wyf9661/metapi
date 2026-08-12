import { describe, expect, it } from 'vitest';
import { normalizePageOffset, normalizePageSize } from './paginationNormalizers.js';

describe('normalizePageSize', () => {
  it('returns fallback for missing / NaN / non-numeric input', () => {
    expect(normalizePageSize(undefined)).toBe(50);
    expect(normalizePageSize('abc')).toBe(50);
    expect(normalizePageSize('')).toBe(50);
    expect(normalizePageSize(42)).toBe(50); // non-string input → fallback
  });

  it('clamps negative and zero values to fallback', () => {
    expect(normalizePageSize('-1')).toBe(50);
    expect(normalizePageSize('0')).toBe(50);
  });

  it('caps at max', () => {
    expect(normalizePageSize('1000000')).toBe(200);
    expect(normalizePageSize('1000000', 50, 500)).toBe(500);
  });

  it('parses valid values', () => {
    expect(normalizePageSize('10')).toBe(10);
    expect(normalizePageSize('250', 50, 500)).toBe(250);
  });
});

describe('normalizePageOffset', () => {
  it('returns fallback for missing / NaN / negative', () => {
    expect(normalizePageOffset(undefined)).toBe(0);
    expect(normalizePageOffset('abc')).toBe(0);
    expect(normalizePageOffset('-5')).toBe(0);
  });

  it('parses valid values', () => {
    expect(normalizePageOffset('100')).toBe(100);
    expect(normalizePageOffset('0')).toBe(0);
  });
});
