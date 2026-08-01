import { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { probeLogs, sites, accounts } from '../../db/schema.js';
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';

export async function registerProbeLogsRoutes(app: FastifyInstance) {
  // 获取测活日志列表
  app.get('/api/probe-logs', async (request, reply) => {
    const {
      siteId,
      accountId,
      modelName,
      status,
      startTime,
      endTime,
      limit = 100,
      offset = 0,
    } = request.query as {
      siteId?: string;
      accountId?: string;
      modelName?: string;
      status?: string;
      startTime?: string;
      endTime?: string;
      limit?: string;
      offset?: string;
    };

    const conditions: any[] = [];

    if (siteId) {
      conditions.push(eq(probeLogs.siteId, parseInt(siteId)));
    }

    if (accountId) {
      conditions.push(eq(probeLogs.accountId, parseInt(accountId)));
    }

    if (modelName) {
      conditions.push(eq(probeLogs.modelName, modelName));
    }

    if (status) {
      conditions.push(eq(probeLogs.status, status));
    }

    if (startTime) {
      conditions.push(gte(probeLogs.createdAt, startTime));
    }

    if (endTime) {
      conditions.push(lte(probeLogs.createdAt, endTime));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const limitNum = typeof limit === 'string' ? parseInt(limit) : limit;
    const offsetNum = typeof offset === 'string' ? parseInt(offset) : offset;

    const logs = await db
      .select({
        id: probeLogs.id,
        siteId: probeLogs.siteId,
        accountId: probeLogs.accountId,
        modelName: probeLogs.modelName,
        questionCategory: probeLogs.questionCategory,
        questionText: probeLogs.questionText,
        responseText: probeLogs.responseText,
        status: probeLogs.status,
        latencyMs: probeLogs.latencyMs,
        tokensUsed: probeLogs.tokensUsed,
        errorMessage: probeLogs.errorMessage,
        createdAt: probeLogs.createdAt,
        siteName: sites.name,
        accountUsername: accounts.username,
      })
      .from(probeLogs)
      .leftJoin(sites, eq(probeLogs.siteId, sites.id))
      .leftJoin(accounts, eq(probeLogs.accountId, accounts.id))
      .where(whereClause)
      .orderBy(desc(probeLogs.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    const total = await db
      .select({ count: sql<number>`count(*)` })
      .from(probeLogs)
      .where(whereClause);

    return {
      logs,
      total: total[0]?.count || 0,
      limit: limitNum,
      offset: offsetNum,
    };
  });

  // 获取单个测活日志详情
  app.get('/api/probe-logs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const log = await db
      .select({
        id: probeLogs.id,
        siteId: probeLogs.siteId,
        accountId: probeLogs.accountId,
        modelName: probeLogs.modelName,
        questionCategory: probeLogs.questionCategory,
        questionText: probeLogs.questionText,
        responseText: probeLogs.responseText,
        status: probeLogs.status,
        latencyMs: probeLogs.latencyMs,
        tokensUsed: probeLogs.tokensUsed,
        errorMessage: probeLogs.errorMessage,
        createdAt: probeLogs.createdAt,
        siteName: sites.name,
        accountUsername: accounts.username,
      })
      .from(probeLogs)
      .leftJoin(sites, eq(probeLogs.siteId, sites.id))
      .leftJoin(accounts, eq(probeLogs.accountId, accounts.id))
      .where(eq(probeLogs.id, parseInt(id)))
      .get();

    if (!log) {
      return reply.status(404).send({ error: 'Probe log not found' });
    }

    return log;
  });

  // 获取测活统计
  app.get('/api/probe-logs/stats', async (request, reply) => {
    const { startTime, endTime } = request.query as {
      startTime?: string;
      endTime?: string;
    };

    const conditions: any[] = [];

    if (startTime) {
      conditions.push(gte(probeLogs.createdAt, startTime));
    }

    if (endTime) {
      conditions.push(lte(probeLogs.createdAt, endTime));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const stats = await db
      .select({
        total: sql<number>`count(*)`,
        success: sql<number>`sum(case when status = 'success' then 1 else 0 end)`,
        failed: sql<number>`sum(case when status = 'failed' then 1 else 0 end)`,
        timeout: sql<number>`sum(case when status = 'timeout' then 1 else 0 end)`,
        avgLatencyMs: sql<number>`avg(latency_ms)`,
        totalTokens: sql<number>`sum(tokens_used)`,
      })
      .from(probeLogs)
      .where(whereClause);

    return stats[0] || {
      total: 0,
      success: 0,
      failed: 0,
      timeout: 0,
      avgLatencyMs: 0,
      totalTokens: 0,
    };
  });

  // 清理旧的测活日志
  app.post('/api/probe-logs/cleanup', async (request, reply) => {
    const { daysToKeep = 7 } = request.body as { daysToKeep?: number };

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffDateStr = cutoffDate.toISOString();

    const result = await db
      .delete(probeLogs)
      .where(sql`${probeLogs.createdAt} < ${cutoffDateStr}`);

    return {
      deletedCount: result.changes || 0,
      cutoffDate: cutoffDateStr,
    };
  });
}
