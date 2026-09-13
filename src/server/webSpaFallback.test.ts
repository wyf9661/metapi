import { describe, expect, it } from 'vitest';
import { isSpaShellFallbackCandidate } from './webSpaFallback.js';

describe('isSpaShellFallbackCandidate', () => {
  it('treats dot-free paths as SPA routes', () => {
    expect(isSpaShellFallbackCandidate('/')).toBe(true);
    expect(isSpaShellFallbackCandidate('/settings')).toBe(true);
    expect(isSpaShellFallbackCandidate('/sites/123')).toBe(true);
    expect(isSpaShellFallbackCandidate('/logs?page=2')).toBe(true);
    expect(isSpaShellFallbackCandidate('/a/b/c#frag')).toBe(true);
  });

  it('rejects asset-like paths so a missing file 404s instead of serving the shell', () => {
    expect(isSpaShellFallbackCandidate('/assets/index-abc123.js')).toBe(false);
    expect(isSpaShellFallbackCandidate('/favicon.ico')).toBe(false);
    expect(isSpaShellFallbackCandidate('/assets/Settings-x1y2.css?v=2')).toBe(false);
    expect(isSpaShellFallbackCandidate('/nested/file.json#frag')).toBe(false);
  });
});
