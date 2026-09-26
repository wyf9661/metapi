import { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { upsertSetting } from '../../db/upsertSetting.js';
import { eq, desc } from 'drizzle-orm';
import { buildCheckinSummaryMessage, checkinAccount, checkinAll } from '../../services/checkinService.js';
import { updateCheckinSchedule } from '../../services/checkinScheduler.js';
import { startBackgroundTask, summarizeCheckinResults } from '../../services/backgroundTaskService.js';
import { classifyFailureReason } from '../../services/failureReasonService.js';
import { normalizePageOffset, normalizePageSize } from './paginationNormalizers.js';

const singleAccountCheckinInFlight = new Map<number, Promise<unknown>>();

export async function checkinRoutes(app: FastifyInstance) {
  // Trigger check-in for all accounts
  app.post('/api/checkin/trigger', async (_, reply) => {
    const { task, reused } = startBackgroundTask(
      {
        type: 'checkin',
        title: '全部账号签到',
        dedupeKey: 'checkin-all',
        notifyOnSuccess: true,
        notifyOnFailure: true,
        successTitle: (currentTask) => {
          const summary = (currentTask.result as any)?.summary;
          if (!summary) return '全部账号签到已完成';
          return `全部账号签到已完成（成功${summary.success}/跳过${summary.skipped}/失败${summary.failed}）`;
        },
        failureTitle: () => '全部账号签到失败',
        successMessage: (currentTask) => {
          const results = (currentTask.result as any)?.results;
          if (!Array.isArray(results) || results.length === 0) return '全部账号签到任务已完成';
          // Same body as the scheduled pass — one layout for every check-in summary.
          return buildCheckinSummaryMessage(results);
        },
        failureMessage: (currentTask) => `全部账号签到任务失败：${currentTask.error || 'unknown error'}`,
      },
      async () => {
        const results = await checkinAll({ scheduleMode: config.checkinScheduleMode });
        return {
          summary: summarizeCheckinResults(results),
          total: results.length,
          results,
        };
      },
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '签到任务执行中，请稍后查看签到日志'
        : '已开始全部签到，请稍后查看签到日志',
    });
  });

  // Trigger check-in for a specific account
  app.post<{ Params: { id: string } }>('/api/checkin/trigger/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ success: false, message: 'Invalid account id' });
    }
    const existing = await db.select({ id: schema.accounts.id })
      .from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    if (!existing) {
      return reply.code(404).send({ success: false, message: 'Account not found' });
    }
    const inflight = singleAccountCheckinInFlight.get(id);
    if (inflight) {
      return reply.code(202).send({
        success: true,
        queued: true,
        reused: true,
        message: '该账号签到任务执行中，请稍后查看签到日志',
      });
    }
    const pending = checkinAccount(id, { scheduleMode: config.checkinScheduleMode })
      .finally(() => {
        singleAccountCheckinInFlight.delete(id);
      });
    singleAccountCheckinInFlight.set(id, pending);
    return pending;
  });

  // Get check-in logs
  app.get<{ Querystring: { limit?: string; offset?: string; accountId?: string } }>('/api/checkin/logs', async (request) => {
    const limit = normalizePageSize(request.query.limit, 50, 200);
    const offset = normalizePageOffset(request.query.offset);
    let query = db.select().from(schema.checkinLogs)
      .innerJoin(schema.accounts, eq(schema.checkinLogs.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .orderBy(desc(schema.checkinLogs.createdAt))
      .limit(limit)
      .offset(offset);

    if (request.query.accountId) {
      const accountId = parseInt(request.query.accountId, 10);
      if (Number.isFinite(accountId) && accountId > 0) {
        query = query.where(eq(schema.checkinLogs.accountId, accountId)) as any;
      }
    }

    const rows = await query.all();
    return rows.map((row: any) => {
      const source = row?.checkin_logs || row;
      const failureReason = classifyFailureReason({
        message: source?.message,
        status: source?.status,
      });
      return {
        ...row,
        failureReason,
      };
    });
  });

  // Update check-in schedule
  app.put<{ Body: { mode?: 'cron' | 'interval'; cron?: string; intervalHours?: number } }>('/api/checkin/schedule', async (request) => {
    try {
      const body = request.body || {};
      const nextMode: 'cron' | 'interval' = body.mode === 'interval' ? 'interval' : 'cron';
      const nextCron = typeof body.cron === 'string' ? body.cron : undefined;
      const nextIntervalHours = body.intervalHours !== undefined ? Number(body.intervalHours) : undefined;
      const normalizedIntervalHours = typeof nextIntervalHours === 'number' && Number.isFinite(nextIntervalHours)
        ? Math.trunc(nextIntervalHours)
        : undefined;

      updateCheckinSchedule({
        mode: nextMode,
        cronExpr: nextCron,
        intervalHours: normalizedIntervalHours,
      });

      await upsertSetting('checkin_schedule_mode', nextMode);
      if (nextCron !== undefined) await upsertSetting('checkin_cron', nextCron);
      if (normalizedIntervalHours !== undefined) {
        await upsertSetting('checkin_interval_hours', normalizedIntervalHours);
      }
      return {
        success: true,
        mode: nextMode,
        cron: nextCron,
        intervalHours: normalizedIntervalHours,
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return { error: errMessage };
    }
  });
}
