import { describe, expect, it } from 'vitest';

describe('token route pattern helpers', () => {
  it('treats bracket-prefixed literal model names as exact patterns', async () => {
    const { isExactTokenRouteModelPattern } = await import('./tokenRoutePatterns.js');
    expect(isExactTokenRouteModelPattern('[NV]deepseek-v3.1-terminus')).toBe(true);
  });

  it('rejects unsafe nested-quantifier regex patterns', async () => {
    const {
      matchesTokenRouteModelPattern,
      parseTokenRouteRegexPattern,
    } = await import('./tokenRoutePatterns.js');

    expect(parseTokenRouteRegexPattern('re:^(a+)+$').regex).toBeNull();
    expect(matchesTokenRouteModelPattern('aaaa', 're:^(a+)+$')).toBe(false);
  });

  it('supports exact, glob, and safe regex route matches', async () => {
    const { matchesTokenRouteModelPattern } = await import('./tokenRoutePatterns.js');

    expect(matchesTokenRouteModelPattern('gpt-4o-mini', 'gpt-4o-mini')).toBe(true);
    expect(matchesTokenRouteModelPattern('claude-sonnet-4-6', 'claude-*')).toBe(true);
    expect(matchesTokenRouteModelPattern('claude-sonnet-4-6', 're:^claude-(opus|sonnet)-4-6$')).toBe(true);
  });
});
