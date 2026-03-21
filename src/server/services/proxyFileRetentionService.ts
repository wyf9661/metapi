import { config } from '../config.js';
import { getLogCleanupCutoffUtc } from './logCleanupService.js';
import { purgeExpiredProxyFiles } from './proxyFileStore.js';

let retentionTimer: ReturnType<typeof setInterval> | null = null;

export function getProxyFileRetentionCutoffUtc(nowMs = Date.now()): string | null {
  const days = Math.max(0, Math.trunc(config.proxyFileRetentionDays));
  if (days <= 0) return null;
  return getLogCleanupCutoffUtc(days, nowMs);
}

export async function cleanupExpiredProxyFiles(nowMs = Date.now()): Promise<{
  enabled: boolean;
  retentionDays: number;
  cutoffUtc: string | null;
  deleted: number;
}> {
  const retentionDays = Math.max(0, Math.trunc(config.proxyFileRetentionDays));
  const cutoffUtc = getProxyFileRetentionCutoffUtc(nowMs);
  if (!cutoffUtc) {
    return {
      enabled: false,
      retentionDays,
      cutoffUtc: null,
      deleted: 0,
    };
  }

  const deleted = await purgeExpiredProxyFiles(cutoffUtc);
  return {
    enabled: true,
    retentionDays,
    cutoffUtc,
    deleted,
  };
}

export function startProxyFileRetentionService(): void {
  if (retentionTimer) return;

  const intervalMinutes = Math.max(1, Math.trunc(config.proxyFileRetentionPruneIntervalMinutes));
  const intervalMs = intervalMinutes * 60 * 1000;
  const runCleanup = async () => {
    try {
      const result = await cleanupExpiredProxyFiles();
      if (!result.enabled || result.deleted <= 0) return;
      console.info(`[proxy-file-retention] deleted ${result.deleted} files before ${result.cutoffUtc}`);
    } catch (error) {
      console.warn('[proxy-file-retention] cleanup failed', error);
    }
  };

  void runCleanup();
  retentionTimer = setInterval(() => { void runCleanup(); }, intervalMs);
  retentionTimer.unref?.();
}

export function stopProxyFileRetentionService(): void {
  if (!retentionTimer) return;
  clearInterval(retentionTimer);
  retentionTimer = null;
}
