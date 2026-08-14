import { beforeEach, describe, expect, it, vi } from 'vitest';

const { detectPlatformMock } = vi.hoisted(() => ({
  detectPlatformMock: vi.fn(),
}));

vi.mock('./platforms/index.js', () => ({
  detectPlatform: detectPlatformMock,
}));

import { detectSite } from './siteDetector.js';

beforeEach(() => {
  detectPlatformMock.mockReset();
});

describe('detectSite', () => {
  it('returns the canonical persisted URL and detected platform', async () => {
    detectPlatformMock.mockResolvedValueOnce({ platformName: 'new-api' });

    await expect(detectSite('https://example.com/v1/chat/completions?foo=bar')).resolves.toEqual({
      url: 'https://example.com',
      platform: 'new-api',
    });
    expect(detectPlatformMock).toHaveBeenCalledWith('https://example.com/v1/chat/completions');
  });

  it('returns null when no platform adapter detects the site', async () => {
    detectPlatformMock.mockResolvedValueOnce(undefined);

    await expect(detectSite('https://unknown.example.com')).resolves.toBeNull();
  });

  it('does not call platform detection with an empty URL', async () => {
    await expect(detectSite('   ')).resolves.toBeNull();
    expect(detectPlatformMock).not.toHaveBeenCalled();
  });
});
