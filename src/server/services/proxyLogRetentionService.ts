import { config } from '../config.js';
import { checkpointSqliteWal } from '../db/index.js';
import { cleanupUsageLogs, getLogCleanupCutoffUtc } from './logCleanupService.js';

let retentionTimer: ReturnType<typeof setInterval> | null = null;

function maybeCheckpointAfterCleanup(deleted: number): void {
  if (deleted <= 0) return;
  // Prefer non-blocking WAL checkpoint over full VACUUM on the live request path.
  checkpointSqliteWal('PASSIVE');
}

export function getProxyLogRetentionCutoffUtc(nowMs = Date.now()): string | null {
  const days = Math.max(0, Math.trunc(config.proxyLogRetentionDays));
  if (days <= 0) return null;
  return getLogCleanupCutoffUtc(days, nowMs);
}

export async function cleanupExpiredProxyLogs(nowMs = Date.now()): Promise<{
  enabled: boolean;
  retentionDays: number;
  cutoffUtc: string | null;
  deleted: number;
}> {
  const retentionDays = Math.max(0, Math.trunc(config.proxyLogRetentionDays));
  const cutoffUtc = getProxyLogRetentionCutoffUtc(nowMs);
  if (!cutoffUtc) {
    return {
      enabled: false,
      retentionDays,
      cutoffUtc: null,
      deleted: 0,
    };
  }

  const { deleted } = await cleanupUsageLogs(retentionDays, nowMs);

  return {
    enabled: true,
    retentionDays,
    cutoffUtc,
    deleted,
  };
}

export function startProxyLogRetentionService(): void {
  if (retentionTimer) return;

  const intervalMinutes = Math.max(1, Math.trunc(config.proxyLogRetentionPruneIntervalMinutes));
  const intervalMs = intervalMinutes * 60 * 1000;
  const runCleanup = async () => {
    try {
      const result = await cleanupExpiredProxyLogs();
      if (!result.enabled || result.deleted <= 0) return;
      console.info(`[proxy-log-retention] deleted ${result.deleted} logs before ${result.cutoffUtc}`);
      maybeCheckpointAfterCleanup(result.deleted);
    } catch (error) {
      console.warn('[proxy-log-retention] cleanup failed', error);
    }
  };

  void runCleanup();
  retentionTimer = setInterval(() => { void runCleanup(); }, intervalMs);
  retentionTimer.unref?.();
}

export function stopProxyLogRetentionService(): void {
  if (!retentionTimer) return;
  clearInterval(retentionTimer);
  retentionTimer = null;
}

export function setLegacyProxyLogRetentionFallbackEnabled(enabled: boolean): void {
  if (enabled) {
    startProxyLogRetentionService();
    return;
  }
  stopProxyLogRetentionService();
}
