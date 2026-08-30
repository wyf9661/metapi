import { describe, expect, it } from 'vitest';
import { parsePositiveIntParam } from './routeParams.js';

describe('parsePositiveIntParam', () => {
  it('parses a valid positive integer', () => {
    expect(parsePositiveIntParam('42')).toBe(42);
    expect(parsePositiveIntParam('1')).toBe(1);
    expect(parsePositiveIntParam(' 7 ')).toBe(7);
  });

  it('returns null for undefined / empty values', () => {
    expect(parsePositiveIntParam(undefined)).toBeNull();
    expect(parsePositiveIntParam('')).toBeNull();
    expect(parsePositiveIntParam(null as unknown as string)).toBeNull();
  });

  it('returns null for NaN / non-numeric values', () => {
    expect(parsePositiveIntParam('abc')).toBeNull();
    expect(parsePositiveIntParam('12abc')).toBeNull();
    expect(parsePositiveIntParam('1.5')).toBeNull();
  });

  it('returns null for zero and negative values', () => {
    expect(parsePositiveIntParam('0')).toBeNull();
    expect(parsePositiveIntParam('-5')).toBeNull();
  });
});
