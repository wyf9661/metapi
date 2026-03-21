import { syncSiteAnnouncements } from './siteAnnouncementService.js';

const DEFAULT_SITE_ANNOUNCEMENT_INTERVAL_MS = 15 * 60 * 1000;

let pollingTimer: ReturnType<typeof setInterval> | null = null;
let syncRunning = false;

async function runSyncOnce() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    await syncSiteAnnouncements();
  } catch (error) {
    console.error('[SiteAnnouncementPolling] Sync failed:', error);
  } finally {
    syncRunning = false;
  }
}

export function startSiteAnnouncementPolling(intervalMs = DEFAULT_SITE_ANNOUNCEMENT_INTERVAL_MS) {
  stopSiteAnnouncementPolling();
  pollingTimer = setInterval(() => {
    void runSyncOnce();
  }, Math.max(10_000, intervalMs));
  pollingTimer.unref?.();
  void runSyncOnce();
  return { intervalMs: Math.max(10_000, intervalMs) };
}

export function stopSiteAnnouncementPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}
