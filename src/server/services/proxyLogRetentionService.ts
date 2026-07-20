import { config } from '../config.js';
import { cleanupUsageLogs, getLogCleanupCutoffUtc } from './logCleanupService.js';

let retentionTimer: ReturnType<typeof setInterval> | null = null;

let lastVacuumAtMs = 0;
const VACUUM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VACUUM_MIN_DELETED = 500;

async function maybeVacuumAfterCleanup(deleted: number): Promise<void> {
  if (deleted < VACUUM_MIN_DELETED) return;
  const now = Date.now();
  if (now - lastVacuumAtMs < VACUUM_MIN_INTERVAL_MS) return;
  // Only SQLite benefits from explicit VACUUM here; skip other dialects.
  try {
    const { config } = await import('../config.js');
    const dialect = String((config as { dbType?: string }).dbType || process.env.DB_TYPE || 'sqlite').toLowerCase();
    if (dialect && dialect !== 'sqlite') return;
    const { db } = await import('../db/index.js');
    // drizzle/better-sqlite session: run raw vacuum through $client when available
    const client = (db as any)?.$client || (db as any)?.session?.client;
    if (client && typeof client.exec === 'function') {
      client.exec('VACUUM');
      lastVacuumAtMs = now;
      console.info(`[proxy-log-retention] VACUUM completed after deleting ${deleted} rows`);
      return;
    }
    if (typeof (db as any)?.run === 'function') {
      await (db as any).run('VACUUM');
      lastVacuumAtMs = now;
      console.info(`[proxy-log-retention] VACUUM completed after deleting ${deleted} rows`);
    }
  } catch (error) {
    console.warn('[proxy-log-retention] VACUUM skipped/failed', error);
  }
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
      await maybeVacuumAfterCleanup(result.deleted);
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
