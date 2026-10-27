import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, eq, gte, lte, or, sql } from 'drizzle-orm';
import {
  withProxyLogSelectFields,
} from '../../services/proxyLogStore.js';
import { calculateProxyRequestLevelMetricsFromAggregates } from '../../services/proxyRequestAggregateMetrics.js';
import {formatUtcSqlDateTime, getLocalRangeStartDayKey} from '../../services/localTimeService.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import {
  getDashboardInsightsSnapshot,
  getDashboardSummarySnapshot,
} from '../../services/dashboardSnapshotService.js';
import { getSiteStatsSnapshot } from '../../services/siteStatsSnapshotService.js';
import {
  runUsageAggregationProjectionPass,
} from '../../services/usageAggregationService.js';
import { registerStatsProxyDebugRoutes } from './statsProxyDebug.js';
import {
  parseBooleanFlag,
  normalizeDashboardView,
} from './stats.pure.js';
import { registerModelsRoutes } from './modelsRoutes.js';
import { registerStatsProxyLogsRoutes } from './statsProxyLogs.js';
export { clearModelsMarketplaceCache } from './modelsRoutes.js';

// The marketplace is the most expensive read endpoint (availability joins +
// 7-day log scans + optional upstream pricing fan-out). Bound it like its
// sibling reads so a client loop cannot pin the DB / upstreams.

// Request-trace metrics run a GROUP BY over proxy_logs with a window that can
// stretch to 90 days; unbounded repeat calls can pin the DB the same way the
// marketplace/model reads can, so bound this endpoint too.
const limitProxyRequestMetricsRead = createRateLimitGuard({
  bucket: 'proxy-request-metrics-read',
  max: 30,
  windowMs: 60_000,
});
// Probe endpoints hit upstreams directly — bound them so a loop cannot
// turn into an upstream probe storm.

export async function statsRoutes(app: FastifyInstance) {

  app.get<{ Querystring: { refresh?: string; view?: string } }>(
    '/api/stats/dashboard',
    async (request, reply) => {
      const forceRefresh = parseBooleanFlag(request.query.refresh);
      const view = normalizeDashboardView(request.query.view);
      if (view === 'summary') {
        const snapshot = await getDashboardSummarySnapshot({ forceRefresh });
        reply.header('x-dashboard-summary-cache', snapshot.cacheStatus);
        return {
          generatedAt: snapshot.generatedAt,
          ...snapshot.payload,
        };
      }
      if (view === 'insights') {
        const snapshot = await getDashboardInsightsSnapshot({ forceRefresh });
        reply.header('x-dashboard-insights-cache', snapshot.cacheStatus);
        return {
          generatedAt: snapshot.generatedAt,
          ...snapshot.payload,
        };
      }

      const [summary, insights] = await Promise.all([
        getDashboardSummarySnapshot({ forceRefresh }),
        getDashboardInsightsSnapshot({ forceRefresh }),
      ]);
      reply.header('x-dashboard-summary-cache', summary.cacheStatus);
      reply.header('x-dashboard-insights-cache', insights.cacheStatus);
      return {
        generatedAt: summary.generatedAt,
        ...summary.payload,
        ...insights.payload,
      };
    },
  );

  // Proxy logs

  // ── SSE: real-time proxy-log push ────────────────────────────
  // Must be registered BEFORE /proxy-logs/:id to avoid matching "stream"
  // as a path param. The client connects via an authenticated fetch stream
  // (POST). POST is used instead of GET because Cloudflare Quick Tunnels
  // buffer GET SSE responses until connection close (cloudflared#1449),
  // while POST responses are streamed in real-time.
  // The server emits a lightweight event on every insertProxyLog; the
  // client receives it and triggers a silent reload of its current page.

  app.get(
    '/api/stats/proxy-request-metrics',
    { preHandler: [limitProxyRequestMetricsRead] },
    async (request) => {
      const query = (request.query || {}) as Record<string, unknown>;
      // Keep unbounded scans opt-in: request-level metrics default to the last 24h.
      const defaultSince = formatUtcSqlDateTime(new Date(Date.now() - 24 * 60 * 60 * 1000));
      const MIN_SINCE_MS = 90 * 24 * 60 * 60 * 1000;
      let since = typeof query.since === 'string' ? query.since : defaultSince;
      const sinceMs = Date.parse(since);
      if (!Number.isFinite(sinceMs) || Date.now() - sinceMs > MIN_SINCE_MS) {
        since = defaultSince;
      }
      const until = typeof query.until === 'string' ? query.until : null;
      const model = typeof query.model === 'string' ? query.model.trim() : '';
      const conditions: any[] = [
        sql`${schema.proxyLogs.requestTraceId} is not null`,
        sql`${schema.proxyLogs.requestTraceId} <> ''`,
        gte(schema.proxyLogs.createdAt, since),
      ];
      if (until) conditions.push(lte(schema.proxyLogs.createdAt, until));
      if (model) {
        conditions.push(or(
          eq(schema.proxyLogs.modelActual, model),
          eq(schema.proxyLogs.modelRequested, model),
        ));
      }

      const rows = await withProxyLogSelectFields(
        async ({ includeRequestTraceId }) => {
          if (!includeRequestTraceId) return [];
          return await db
            .select({
              requestTraceId: schema.proxyLogs.requestTraceId,
              attemptCount: sql<number>`count(*)`,
              firstAttemptRetry: sql<number>`min(coalesce(${schema.proxyLogs.retryCount}, 0))`,
              firstSuccessRetry: sql<number | null>`min(case when ${schema.proxyLogs.status} = 'success' then coalesce(${schema.proxyLogs.retryCount}, 0) end)`,
              successCount: sql<number>`sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end)`,
            })
            .from(schema.proxyLogs)
            .where(and(...conditions))
            .groupBy(schema.proxyLogs.requestTraceId)
            .all();
        },
        { includeRequestTraceId: true },
      );

      const requestLevel = calculateProxyRequestLevelMetricsFromAggregates(rows);
      return {
        since,
        until,
        attemptCount: rows.reduce(
          (total: number, row: { attemptCount?: number | string | null }) => (
            total + Number(row.attemptCount || 0)
          ),
          0,
        ),
        requestLevel,
      };
    },
  );

  // Models marketplace - refresh upstream models and aggregate.

  // Refresh models for one account and rebuild routes.

  // On-demand marketplace probe (safe, non-batch)
  // - model only: probe all accounts that list the model
  // - with siteId/accountId: probe only that supplier/account

  // Streaming marketplace probe — SSE, one event per account as it finishes.
  // Event types: "start" (targets list), "result" (per-account), "done" (aggregate).

  // Site distribution – per-site aggregate data
  app.get<{ Querystring: { days?: string; refresh?: string } }>(
    '/api/stats/site-distribution',
    async (request) => {
      const rawDays = request.query.days ? parseInt(request.query.days, 10) : 7;
      const days = Number.isFinite(rawDays)
        ? Math.max(1, Math.min(365, rawDays))
        : 7;
      const snapshot = await getSiteStatsSnapshot({
        days,
        forceRefresh: parseBooleanFlag(request.query.refresh),
      });
      return { distribution: snapshot.payload.distribution };
    },
  );

  // Site trend – daily spend/calls broken down by site
  app.get<{ Querystring: { days?: string; refresh?: string } }>(
    '/api/stats/site-trend',
    async (request) => {
      const rawDays = request.query.days ? parseInt(request.query.days, 10) : 7;
      const days = Number.isFinite(rawDays)
        ? Math.max(1, Math.min(365, rawDays))
        : 7;
      const snapshot = await getSiteStatsSnapshot({
        days,
        forceRefresh: parseBooleanFlag(request.query.refresh),
      });
      return { trend: snapshot.payload.trend };
    },
  );

  // Model stats by site
  app.get<{ Querystring: { siteId?: string; days?: string } }>(
    '/api/stats/model-by-site',
    async (request) => {
      const siteId = request.query.siteId
        ? parseInt(request.query.siteId, 10)
        : null;
    const days = Number.isFinite(parseInt(request.query.days || '7', 10))
      ? Math.max(1, Math.min(365, parseInt(request.query.days || '7', 10)))
      : 7;
      await runUsageAggregationProjectionPass();
      const sinceDay = getLocalRangeStartDayKey(days);
      const rows = siteId != null && Number.isFinite(siteId)
        ? await db
            .select()
            .from(schema.modelDayUsage)
            .where(
              and(
                gte(schema.modelDayUsage.localDay, sinceDay),
                eq(schema.modelDayUsage.siteId, siteId),
              ),
            )
            .all()
        : await db
            .select()
            .from(schema.modelDayUsage)
            .where(gte(schema.modelDayUsage.localDay, sinceDay))
            .all();

      const modelMap: Record<
        string,
        { calls: number; spend: number; tokens: number }
      > = {};

      for (const row of rows) {
        const model = row.model || 'unknown';

        if (!modelMap[model])
          modelMap[model] = { calls: 0, spend: 0, tokens: 0 };
        modelMap[model].calls += Number(row.totalCalls || 0);
        modelMap[model].tokens += Number(row.totalTokens || 0);
        modelMap[model].spend += Number(row.totalSpend || 0);
      }

      const models = Object.entries(modelMap)
        .map(([model, stats]) => ({
          model,
          calls: stats.calls,
          spend: Math.round(stats.spend * 1_000_000) / 1_000_000,
          tokens: stats.tokens,
        }))
        .sort((a, b) => b.calls - a.calls);

      return { models };
    },
  );

  registerStatsProxyDebugRoutes(app);

  registerModelsRoutes(app);

  registerStatsProxyLogsRoutes(app);
}
