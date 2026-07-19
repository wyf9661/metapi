import { describe, expect, it } from 'vitest';
import { maskToken, normalizeTokenForDisplay } from './accountTokenService.js';

describe('maskToken', () => {
  it('keeps sk- prefix for short tokens', () => {
    const masked = maskToken('sk-abcde');
    expect(masked.startsWith('sk-')).toBe(true);
    expect(masked.includes('***')).toBe(true);
  });

  it('keeps sk- prefix for long tokens', () => {
    const masked = maskToken('sk-proj-abcdefghijklmnopqrstuvwxyz123456');
    expect(masked.startsWith('sk-')).toBe(true);
    expect(masked.includes('***')).toBe(true);
  });

  it('adds sk- prefix for new-api display when upstream key misses prefix', () => {
    const masked = maskToken('5Uh6KjAgVOqQxNv97MAS7abkBf7Fg5GphgBXUpAOuvq2IvL4', 'new-api');
    expect(masked.startsWith('sk-')).toBe(true);
  });
});

describe('normalizeTokenForDisplay', () => {
  it('adds sk- for any platform when token misses prefix', () => {
    expect(normalizeTokenForDisplay('abc123', 'new-api')).toBe('sk-abc123');
    expect(normalizeTokenForDisplay('xyz789', 'one-api')).toBe('sk-xyz789');
    expect(normalizeTokenForDisplay('pqr456', 'new-api')).toBe('sk-pqr456');
    expect(normalizeTokenForDisplay('uvw000', 'one-api')).toBe('sk-uvw000');
  });

  it('keeps existing sk- token unchanged', () => {
    expect(normalizeTokenForDisplay('sk-abc123', 'one-api')).toBe('sk-abc123');
  });
});
