import cron from 'node-cron';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { refreshAllBalances } from './balanceService.js';
import { checkinAll } from './checkinService.js';
import * as routeRefreshWorkflow from './routeRefreshWorkflow.js';
import { sendNotification } from './notifyService.js';
import { buildDailySummaryNotification, collectDailySummaryMetrics } from './dailySummaryService.js';
import { cleanupConfiguredLogs } from './logCleanupService.js';
import { normalizeLogCleanupRetentionDays } from '../shared/logCleanupRetentionDays.js';

export type CheckinScheduleMode = 'cron' | 'interval';

let checkinTask: cron.ScheduledTask | null = null;
let checkinIntervalTimer: ReturnType<typeof setInterval> | null = null;
let balanceTask: cron.ScheduledTask | null = null;
let dailySummaryTask: cron.ScheduledTask | null = null;
let logCleanupTask: cron.ScheduledTask | null = null;
const intervalAttemptByAccount = new Map<number, number>();

const DAILY_SUMMARY_DEFAULT_CRON = '58 23 * * *';
const LOG_CLEANUP_DEFAULT_CRON = '0 6 * * *';
const CHECKIN_INTERVAL_POLL_MS = 60_000;

async function resolveJsonSetting<T>(
  settingKey: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
): Promise<T> {
  try {
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, settingKey)).get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (isValid(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return fallback;
}

async function resolveCronSetting(settingKey: string, fallback: string): Promise<string> {
  return resolveJsonSetting(settingKey, (value): value is string => typeof value === 'string' && cron.validate(value), fallback);
}

async function resolveBooleanSetting(settingKey: string, fallback: boolean): Promise<boolean> {
  return resolveJsonSetting(settingKey, (value): value is boolean => typeof value === 'boolean', fallback);
}

async function resolvePositiveIntegerSetting(settingKey: string, fallback: number): Promise<number> {
  return resolveJsonSetting(
    settingKey,
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1,
    fallback,
  );
}


function summarizeCheckinRun(results: Array<{ result?: any }>) {
  let success = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of results) {
    const status = item?.result?.status;
    if (status === 'skipped' || item?.result?.skipped) {
      skipped += 1;
      continue;
    }
    if (item?.result?.success) success += 1;
    else failed += 1;
  }
  return { total: results.length, success, skipped, failed };
}

function buildCheckinSummaryNotification(results: Array<{ accountId?: number; username?: string; site?: string; result?: any }>) {
  const summary = summarizeCheckinRun(results);
  const lines: string[] = [
    `全部账号签到完成：成功 ${summary.success}，跳过 ${summary.skipped}，失败 ${summary.failed}`,
  ];
  const failedRows = results.filter((item) => {
    const status = item?.result?.status;
    if (status === 'skipped' || item?.result?.skipped) return false;
    return !item?.result?.success;
  }).slice(0, 8);
  if (failedRows.length > 0) {
    lines.push('失败明细:');
    for (const item of failedRows) {
      const label = `${item?.username || (item?.accountId ? `#${item.accountId}` : 'unknown')} @ ${item?.site || 'unknown'}`;
      const reason = String(item?.result?.message || 'failed').trim().slice(0, 80);
      lines.push(`- ${label}: ${reason}`);
    }
    if (summary.failed > failedRows.length) {
      lines.push(`- ... 另有 ${summary.failed - failedRows.length} 个失败未展开`);
    }
  }
  const title = summary.failed > 0
    ? `签到完成（成功${summary.success}/失败${summary.failed}）`
    : `签到完成（成功${summary.success}）`;
  return {
    title,
    message: lines.join('\n'),
    level: (summary.failed > 0 ? 'warning' : 'info') as 'info' | 'warning' | 'error',
    summary,
  };
}

async function notifyCheckinSummary(results: Array<{ accountId?: number; username?: string; site?: string; result?: any }>) {
  const notification = buildCheckinSummaryNotification(results);
  try {
    await sendNotification(notification.title, notification.message, notification.level, {
      // full-run summary should always attempt delivery once
      bypassThrottle: true,
    });
  } catch (error) {
    console.warn('[Scheduler] Check-in notification failed:', (error as Error)?.message || error);
  }
  return notification;
}

function createCheckinTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Running check-in at ${new Date().toISOString()}`);
    try {
      const results = await checkinAll({ scheduleMode: 'cron' });
      const notification = await notifyCheckinSummary(results as any);
      console.log(
        `[Scheduler] Check-in complete: ${notification.summary.success} success, ${notification.summary.skipped} skipped, ${notification.summary.failed} failed`,
      );
    } catch (err) {
      console.error('[Scheduler] Check-in error:', err);
      try {
        await sendNotification(
          '定时签到失败',
          `定时签到任务异常：${err instanceof Error ? err.message : String(err)}`,
          'error',
          { bypassThrottle: true },
        );
      } catch {}
    }
  });
}

type IntervalCheckinCandidate = {
  id: number;
  lastCheckinAt?: string | null;
};

export function selectDueIntervalCheckinAccountIds(
  rows: IntervalCheckinCandidate[],
  intervalHours: number,
  now = new Date(),
  attemptState = intervalAttemptByAccount,
) {
  const nowMs = now.getTime();
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

  return rows
    .filter((row) => {
      const lastCheckinMs = row.lastCheckinAt ? Date.parse(row.lastCheckinAt) : Number.NaN;
      const lastAttemptMs = attemptState.get(row.id);
      if (Number.isFinite(lastCheckinMs)) {
        if (nowMs - lastCheckinMs < intervalMs) return false;
        if (typeof lastAttemptMs === 'number' && lastAttemptMs >= lastCheckinMs && nowMs - lastAttemptMs < intervalMs) {
          return false;
        }
        return true;
      }
      if (typeof lastAttemptMs === 'number' && nowMs - lastAttemptMs < intervalMs) return false;
      return true;
    })
    .map((row) => row.id);
}

async function runIntervalCheckinPass(now = new Date()) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const dueAccountIds = selectDueIntervalCheckinAccountIds(
    rows
      .filter((row: any) => row.accounts?.checkinEnabled === true && row.accounts?.status === 'active' && row.sites?.status !== 'disabled')
      .map((row: any) => ({
        id: row.accounts.id,
        lastCheckinAt: row.accounts.lastCheckinAt,
      })),
    config.checkinIntervalHours,
    now,
  );

  if (dueAccountIds.length === 0) return;

  try {
    const results = await checkinAll({
      accountIds: dueAccountIds,
      scheduleMode: 'interval',
    });
    const nowMs = now.getTime();
    for (const item of results) {
      intervalAttemptByAccount.set(item.accountId, nowMs);
    }
    const notification = await notifyCheckinSummary(results as any);
    console.log(
      `[Scheduler] Interval check-in complete: ${notification.summary.success} success, ${notification.summary.skipped} skipped, ${notification.summary.failed} failed`,
    );
  } catch (err) {
    console.error('[Scheduler] Interval check-in error:', err);
    try {
      await sendNotification(
        '间隔签到失败',
        `间隔签到任务异常：${err instanceof Error ? err.message : String(err)}`,
        'error',
        { bypassThrottle: true },
      );
    } catch {}
  }
}

function stopCheckinSchedule() {
  checkinTask?.stop();
  checkinTask = null;
  if (checkinIntervalTimer) {
    clearInterval(checkinIntervalTimer);
    checkinIntervalTimer = null;
  }
}

function startCheckinSchedule() {
  stopCheckinSchedule();
  if (config.checkinScheduleMode === 'interval') {
    checkinIntervalTimer = setInterval(() => {
      void runIntervalCheckinPass();
    }, CHECKIN_INTERVAL_POLL_MS);
    return;
  }
  checkinTask = createCheckinTask(config.checkinCron);
}

function createBalanceTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Refreshing balances at ${new Date().toISOString()}`);
    try {
      await refreshAllBalances();
      await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
      console.log('[Scheduler] Balance refresh complete');
    } catch (err) {
      console.error('[Scheduler] Balance refresh error:', err);
    }
  });
}

function createDailySummaryTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Sending daily summary at ${new Date().toISOString()}`);
    try {
      const metrics = await collectDailySummaryMetrics();
      const { title, message } = buildDailySummaryNotification(metrics);
      await sendNotification(title, message, 'info', {
        bypassThrottle: true,
        requireChannel: true,
        throwOnFailure: true,
      });
      console.log(`[Scheduler] Daily summary sent: ${title}`);
    } catch (err) {
      console.error('[Scheduler] Daily summary error:', err);
    }
  });
}

function createLogCleanupTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    if (!config.logCleanupConfigured) {
      console.log('[Scheduler] Log cleanup skipped: legacy fallback mode is active');
      return;
    }
    console.log(`[Scheduler] Running log cleanup at ${new Date().toISOString()}`);
    try {
      const result = await cleanupConfiguredLogs();
      if (!result.enabled) {
        console.log('[Scheduler] Log cleanup skipped: no log target enabled');
        return;
      }
      console.log(
        `[Scheduler] Log cleanup complete: usage=${result.usageLogsDeleted}, program=${result.programLogsDeleted}, cutoff=${result.cutoffUtc}`,
      );
    } catch (err) {
      console.error('[Scheduler] Log cleanup error:', err);
    }
  });
}

export async function startScheduler() {
  const activeCheckinCron = await resolveCronSetting('checkin_cron', config.checkinCron);
  const activeCheckinScheduleMode = await resolveJsonSetting<CheckinScheduleMode>(
    'checkin_schedule_mode',
    (value): value is CheckinScheduleMode => value === 'cron' || value === 'interval',
    config.checkinScheduleMode as CheckinScheduleMode,
  );
  const activeCheckinIntervalHours = await resolvePositiveIntegerSetting(
    'checkin_interval_hours',
    config.checkinIntervalHours,
  );
  const activeBalanceCron = await resolveCronSetting('balance_refresh_cron', config.balanceRefreshCron);
  const activeDailySummaryCron = await resolveCronSetting('daily_summary_cron', DAILY_SUMMARY_DEFAULT_CRON);
  const activeLogCleanupCron = await resolveCronSetting('log_cleanup_cron', config.logCleanupCron || LOG_CLEANUP_DEFAULT_CRON);
  const activeLogCleanupUsageLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_usage_logs_enabled',
    config.logCleanupUsageLogsEnabled,
  );
  const activeLogCleanupProgramLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_program_logs_enabled',
    config.logCleanupProgramLogsEnabled,
  );
  const activeLogCleanupRetentionDays = await resolvePositiveIntegerSetting(
    'log_cleanup_retention_days',
    normalizeLogCleanupRetentionDays(config.logCleanupRetentionDays),
  );
  config.checkinCron = activeCheckinCron;
  config.checkinScheduleMode = activeCheckinScheduleMode;
  config.checkinIntervalHours = Math.min(24, Math.max(1, activeCheckinIntervalHours));
  config.balanceRefreshCron = activeBalanceCron;
  config.logCleanupCron = activeLogCleanupCron;
  config.logCleanupUsageLogsEnabled = activeLogCleanupUsageLogsEnabled;
  config.logCleanupProgramLogsEnabled = activeLogCleanupProgramLogsEnabled;
  config.logCleanupRetentionDays = activeLogCleanupRetentionDays;

  stopCheckinSchedule();
  balanceTask?.stop();
  dailySummaryTask?.stop();
  logCleanupTask?.stop();
  startCheckinSchedule();
  balanceTask = createBalanceTask(activeBalanceCron);
  dailySummaryTask = createDailySummaryTask(activeDailySummaryCron);
  logCleanupTask = createLogCleanupTask(activeLogCleanupCron);

  console.log(`[Scheduler] Check-in schedule: ${config.checkinScheduleMode} (${config.checkinScheduleMode === 'cron' ? activeCheckinCron : `${config.checkinIntervalHours}h`})`);
  console.log(`[Scheduler] Balance refresh cron: ${activeBalanceCron}`);
  console.log(`[Scheduler] Daily summary cron: ${activeDailySummaryCron}`);
  console.log(
    `[Scheduler] Log cleanup cron: ${activeLogCleanupCron} (configured=${config.logCleanupConfigured}, usage=${activeLogCleanupUsageLogsEnabled}, program=${activeLogCleanupProgramLogsEnabled}, retentionDays=${activeLogCleanupRetentionDays})`,
  );
}

export function updateCheckinCron(cronExpr: string) {
  updateCheckinSchedule({
    mode: 'cron',
    cronExpr,
    intervalHours: config.checkinIntervalHours,
  });
}

export function updateCheckinSchedule(input: {
  mode: CheckinScheduleMode;
  cronExpr?: string;
  intervalHours?: number;
}) {
  const nextMode = input.mode;
  if (nextMode !== 'cron' && nextMode !== 'interval') {
    throw new Error(`Invalid checkin schedule mode: ${String(nextMode)}`);
  }

  const nextCronExpr = input.cronExpr ?? config.checkinCron;
  if (!cron.validate(nextCronExpr)) throw new Error(`Invalid cron: ${nextCronExpr}`);

  const nextIntervalHours = input.intervalHours ?? config.checkinIntervalHours;
  if (!Number.isFinite(nextIntervalHours) || nextIntervalHours < 1 || nextIntervalHours > 24) {
    throw new Error(`Invalid interval hours: ${String(nextIntervalHours)}`);
  }

  config.checkinScheduleMode = nextMode;
  config.checkinCron = nextCronExpr;
  config.checkinIntervalHours = Math.trunc(nextIntervalHours);
  startCheckinSchedule();
}

export function updateBalanceRefreshCron(cronExpr: string) {
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);
  config.balanceRefreshCron = cronExpr;
  balanceTask?.stop();
  balanceTask = createBalanceTask(cronExpr);
}

export function updateLogCleanupSettings(input: {
  cronExpr?: string;
  usageLogsEnabled?: boolean;
  programLogsEnabled?: boolean;
  retentionDays?: number;
}) {
  const cronExpr = input.cronExpr ?? config.logCleanupCron;
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);

  const retentionDays = normalizeLogCleanupRetentionDays(input.retentionDays ?? config.logCleanupRetentionDays);

  config.logCleanupCron = cronExpr;
  if (input.usageLogsEnabled !== undefined) config.logCleanupUsageLogsEnabled = !!input.usageLogsEnabled;
  if (input.programLogsEnabled !== undefined) config.logCleanupProgramLogsEnabled = !!input.programLogsEnabled;
  config.logCleanupRetentionDays = retentionDays;

  logCleanupTask?.stop();
  logCleanupTask = createLogCleanupTask(cronExpr);
}

export function __resetCheckinSchedulerForTests() {
  stopCheckinSchedule();
  balanceTask?.stop();
  dailySummaryTask?.stop();
  logCleanupTask?.stop();
  balanceTask = null;
  dailySummaryTask = null;
  logCleanupTask = null;
  intervalAttemptByAccount.clear();
}
