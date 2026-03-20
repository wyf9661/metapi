import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const syncSiteAnnouncementsMock = vi.fn();

vi.mock('./siteAnnouncementService.js', () => ({
  syncSiteAnnouncements: (...args: unknown[]) => syncSiteAnnouncementsMock(...args),
}));

describe('siteAnnouncementPollingService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    syncSiteAnnouncementsMock.mockReset();
  });

  afterEach(async () => {
    const module = await import('./siteAnnouncementPollingService.js');
    module.stopSiteAnnouncementPolling();
    vi.useRealTimers();
  });

  it('runs one immediate sync and then continues on the configured interval', async () => {
    const module = await import('./siteAnnouncementPollingService.js');
    syncSiteAnnouncementsMock.mockResolvedValue(undefined);

    module.startSiteAnnouncementPolling(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncSiteAnnouncementsMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncSiteAnnouncementsMock).toHaveBeenCalledTimes(2);
  });
});
