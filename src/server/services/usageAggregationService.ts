import { and, asc, eq, gt, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { db, runtimeDbDialect, schema } from '../db/index.js';
import { fallbackTokenCost } from './modelPricingService.js';
import {
  getLocalRangeStartDayKey,
  getResolvedTimeZone,
  toLocalDayKeyFromStoredUtc,
  toLocalDayStartUtcFromStoredUtc,
  toLocalHourStartUtcFromStoredUtc,
  type StoredUtcDateTimeInput,
} from './localTimeService.js';
import { clearSnapshotCache } from './snapshotCacheService.js';

const USAGE_PROJECTOR_KEY = 'usage-aggregates-v1';
const PROJECTION_BATCH_SIZE = 1_000;
const PROJECTION_MAX_BATCHES_PER_PASS = 120;
const PROJECTION_INTERVAL_MS = 5_000;
const PROJECTION_LEASE_MS = 10 * 60_000;

type ProjectionCheckpointRow = typeof schema.analyticsProjectionCheckpoints.$inferSelect;
type ProjectionLease = {
  owner: string;
  token: string;
  expiresAt: string;
};

type ProjectionPassOptions = {
  maxBatches?: number;
};

type ProxyLogProjectionRow = {
  id: number;
  createdAt: StoredUtcDateTimeInput;
  status: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  modelActual: string | null;
  modelRequested: string | null;
  siteId: number | null;
  sitePlatform: string | null;
};

type SiteDayUsageDeltaRow = {
  localDay: string;
  siteId: number;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  totalTokens: number;
  totalSummarySpend: number;
  totalSiteSpend: number;
  totalLatencyMs: number;
  latencyCount: number;
};

type SiteHourUsageDeltaRow = {
  bucketStartUtc: string;
  siteId: number;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  totalTokens: number;
  totalSummarySpend: number;
  totalSiteSpend: number;
  totalLatencyMs: number;
  latencyCount: number;
};

type ModelDayUsageDeltaRow = {
  localDay: string;
  siteId: number;
  model: string;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  totalTokens: number;
  totalSpend: number;
  totalLatencyMs: number;
  latencyCount: number;
};

type ProjectionBatchDelta = {
  siteDayRows: SiteDayUsageDeltaRow[];
  siteHourRows: SiteHourUsageDeltaRow[];
  modelDayRows: ModelDayUsageDeltaRow[];
};

export type ProjectionPassResult = {
  processedLogs: number;
  watermarkId: number;
  recomputed: boolean;
};

export type SiteHourUsageAggregateRow = {
  siteId: number;
  hourStartUtc: string;
  totalRequests: number;
  successCount: number;
  failedCount: number;
  totalTokens: number;
  totalSummarySpend: number;
  totalSiteSpend: number;
  totalLatencyMs: number;
  latencyCount: number;
};

export type ModelDayUsageAggregateRow = {
  siteId: number;
  day: string;
  model: string;
  totalCalls: number;
  successCount: number;
  failedCount: number;
  totalTokens: number;
  totalSpend: number;
  totalLatencyMs: number;
  latencyCount: number;
};

let projectionTimer: ReturnType<typeof setInterval> | null = null;
let projectionInFlight: Promise<ProjectionPassResult> | null = null;

function emptyCheckpoint(): ProjectionCheckpointRow {
  return {
    projectorKey: USAGE_PROJECTOR_KEY,
    timeZone: getResolvedTimeZone(),
    lastProxyLogId: 0,
    watermarkCreatedAt: null,
    recomputeFromId: null,
    recomputeRequestedAt: null,
    recomputeReason: null,
    recomputeStartedAt: null,
    recomputeCompletedAt: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastProjectedAt: null,
    lastSuccessfulAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
  };
}

function normalizeNonNegativeInt(value: unknown): number {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric);
}

function normalizeNonNegativeFloat(value: unknown): number {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric;
}

function resolveSummarySpend(params: {
  estimatedCost: number | null;
  totalTokens: number | null;
  platform: string | null;
}) {
  const explicit = normalizeNonNegativeFloat(params.estimatedCost);
  if (explicit > 0) return explicit;
  const tokens = normalizeNonNegativeInt(params.totalTokens);
  if (tokens <= 0) return 0;
  return String(params.platform || '').trim().toLowerCase() === 'veloera'
    ? tokens / 1_000_000
    : tokens / 500_000;
}

function resolveSiteSpend(params: {
  estimatedCost: number | null;
  totalTokens: number | null;
  platform: string | null;
}) {
  const explicit = normalizeNonNegativeFloat(params.estimatedCost);
  if (explicit > 0) return explicit;
  const tokens = normalizeNonNegativeInt(params.totalTokens);
  if (tokens <= 0) return 0;
  return fallbackTokenCost(tokens, params.platform || 'new-api');
}

function resolveModelSpend(params: {
  estimatedCost: number | null;
  totalTokens: number | null;
}) {
  const explicit = normalizeNonNegativeFloat(params.estimatedCost);
  if (explicit > 0) return explicit;
  const tokens = normalizeNonNegativeInt(params.totalTokens);
  if (tokens <= 0) return 0;
  return tokens / 500_000;
}

function resolveModelName(row: ProxyLogProjectionRow): string {
  return String(row.modelActual || row.modelRequested || 'unknown').trim() || 'unknown';
}

function clearAnalyticsSnapshots() {
  clearSnapshotCache('site-stats');
  clearSnapshotCache('dashboard-summary');
  clearSnapshotCache('dashboard-insights');
}

function buildProjectionLeaseOwner() {
  const host = String(hostname() || process.env.HOSTNAME || 'local').trim() || 'local';
  return `${host}:${process.pid}`;
}

function buildProjectionLeaseExpiry(nowMs = Date.now()) {
  return new Date(nowMs + PROJECTION_LEASE_MS).toISOString();
}

function normalizeProjectionError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error || 'unknown projection error');
}

async function readProjectionCheckpoint(): Promise<ProjectionCheckpointRow> {
  const row = await db
    .select()
    .from(schema.analyticsProjectionCheckpoints)
    .where(eq(schema.analyticsProjectionCheckpoints.projectorKey, USAGE_PROJECTOR_KEY))
    .get();
  return row || emptyCheckpoint();
}

async function ensureProjectionCheckpointExists() {
  const nowIso = new Date().toISOString();
  const values = {
    projectorKey: USAGE_PROJECTOR_KEY,
    timeZone: getResolvedTimeZone(),
    lastProxyLogId: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (runtimeDbDialect === 'mysql') {
    await (db.insert(schema.analyticsProjectionCheckpoints).values(values) as any)
      .onDuplicateKeyUpdate({
        set: {
          projectorKey: sql`${schema.analyticsProjectionCheckpoints.projectorKey}`,
        },
      })
      .run();
    return;
  }

  await (db.insert(schema.analyticsProjectionCheckpoints).values(values) as any)
    .onConflictDoNothing({
      target: schema.analyticsProjectionCheckpoints.projectorKey,
    })
    .run();
}

async function tryAcquireProjectionLease(): Promise<ProjectionLease | null> {
  await ensureProjectionCheckpointExists();
  const nowIso = new Date().toISOString();
  const lease: ProjectionLease = {
    owner: buildProjectionLeaseOwner(),
    token: randomUUID(),
    expiresAt: buildProjectionLeaseExpiry(),
  };

  const result = await db
    .update(schema.analyticsProjectionCheckpoints)
    .set({
      leaseOwner: lease.owner,
      leaseToken: lease.token,
      leaseExpiresAt: lease.expiresAt,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.analyticsProjectionCheckpoints.projectorKey, USAGE_PROJECTOR_KEY),
        or(
          isNull(schema.analyticsProjectionCheckpoints.leaseExpiresAt),
          lte(schema.analyticsProjectionCheckpoints.leaseExpiresAt, nowIso),
        ),
      ),
    )
    .run();

  return result.changes > 0 ? lease : null;
}

async function releaseProjectionLease(
  lease: ProjectionLease,
  options?: { error?: unknown },
) {
  const nowIso = new Date().toISOString();
  await db
    .update(schema.analyticsProjectionCheckpoints)
    .set({
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: options?.error ? normalizeProjectionError(options.error) : null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.analyticsProjectionCheckpoints.projectorKey, USAGE_PROJECTOR_KEY),
        eq(schema.analyticsProjectionCheckpoints.leaseToken, lease.token),
      ),
    )
    .run();
}

async function writeProjectionCheckpoint(
  tx: typeof db,
  checkpoint: Partial<ProjectionCheckpointRow> & { lastProxyLogId: number },
) {
  const nowIso = new Date().toISOString();
  const values = {
    projectorKey: USAGE_PROJECTOR_KEY,
    timeZone: checkpoint.timeZone ?? getResolvedTimeZone(),
    lastProxyLogId: Math.max(0, Math.trunc(checkpoint.lastProxyLogId || 0)),
    watermarkCreatedAt: checkpoint.watermarkCreatedAt ?? null,
    recomputeFromId: checkpoint.recomputeFromId ?? null,
    recomputeRequestedAt: checkpoint.recomputeRequestedAt ?? null,
    recomputeReason: checkpoint.recomputeReason ?? null,
    recomputeStartedAt: checkpoint.recomputeStartedAt ?? null,
    recomputeCompletedAt: checkpoint.recomputeCompletedAt ?? null,
    leaseOwner: checkpoint.leaseOwner ?? null,
    leaseToken: checkpoint.leaseToken ?? null,
    leaseExpiresAt: checkpoint.leaseExpiresAt ?? null,
    lastProjectedAt: checkpoint.lastProjectedAt ?? nowIso,
    lastSuccessfulAt: checkpoint.lastSuccessfulAt ?? nowIso,
    lastError: checkpoint.lastError ?? null,
    createdAt: checkpoint.createdAt ?? nowIso,
    updatedAt: nowIso,
  };

  if (runtimeDbDialect === 'mysql') {
    await (tx.insert(schema.analyticsProjectionCheckpoints).values(values) as any)
      .onDuplicateKeyUpdate({
        set: {
          timeZone: values.timeZone,
          lastProxyLogId: values.lastProxyLogId,
          watermarkCreatedAt: values.watermarkCreatedAt,
          recomputeFromId: values.recomputeFromId,
          recomputeRequestedAt: values.recomputeRequestedAt,
          recomputeReason: values.recomputeReason,
          recomputeStartedAt: values.recomputeStartedAt,
          recomputeCompletedAt: values.recomputeCompletedAt,
          leaseOwner: values.leaseOwner,
          leaseToken: values.leaseToken,
          leaseExpiresAt: values.leaseExpiresAt,
          lastProjectedAt: values.lastProjectedAt,
          lastSuccessfulAt: values.lastSuccessfulAt,
          lastError: values.lastError,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    return;
  }

  await (tx.insert(schema.analyticsProjectionCheckpoints).values(values) as any)
    .onConflictDoUpdate({
      target: schema.analyticsProjectionCheckpoints.projectorKey,
      set: {
        timeZone: values.timeZone,
        lastProxyLogId: values.lastProxyLogId,
        watermarkCreatedAt: values.watermarkCreatedAt,
        recomputeFromId: values.recomputeFromId,
        recomputeRequestedAt: values.recomputeRequestedAt,
        recomputeReason: values.recomputeReason,
        recomputeStartedAt: values.recomputeStartedAt,
        recomputeCompletedAt: values.recomputeCompletedAt,
        leaseOwner: values.leaseOwner,
        leaseToken: values.leaseToken,
        leaseExpiresAt: values.leaseExpiresAt,
        lastProjectedAt: values.lastProjectedAt,
        lastSuccessfulAt: values.lastSuccessfulAt,
        lastError: values.lastError,
        updatedAt: values.updatedAt,
      },
    })
    .run();
}

async function fetchProjectionBatch(afterId: number, limit: number) {
  const rows = await db
    .select({
      id: schema.proxyLogs.id,
      createdAt: schema.proxyLogs.createdAt,
      status: schema.proxyLogs.status,
      latencyMs: schema.proxyLogs.latencyMs,
      totalTokens: schema.proxyLogs.totalTokens,
      estimatedCost: schema.proxyLogs.estimatedCost,
      modelActual: schema.proxyLogs.modelActual,
      modelRequested: schema.proxyLogs.modelRequested,
      siteId: schema.sites.id,
      sitePlatform: schema.sites.platform,
    })
    .from(schema.proxyLogs)
    .leftJoin(schema.accounts, eq(schema.proxyLogs.accountId, schema.accounts.id))
    .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(gt(schema.proxyLogs.id, afterId))
    .orderBy(asc(schema.proxyLogs.id))
    .limit(limit)
    .all();

  return rows as ProxyLogProjectionRow[];
}

function buildProjectionBatchDelta(rows: ProxyLogProjectionRow[]): ProjectionBatchDelta {
  const siteDayMap = new Map<string, SiteDayUsageDeltaRow>();
  const siteHourMap = new Map<string, SiteHourUsageDeltaRow>();
  const modelDayMap = new Map<string, ModelDayUsageDeltaRow>();

  for (const row of rows) {
    const siteId = typeof row.siteId === 'number' && row.siteId > 0 ? row.siteId : null;
    if (!siteId) continue;

    const localDay = toLocalDayKeyFromStoredUtc(row.createdAt);
    const bucketStartUtc = toLocalHourStartUtcFromStoredUtc(row.createdAt);
    if (!localDay || !bucketStartUtc) continue;

    const status = String(row.status || '').trim().toLowerCase();
    const isSuccess = status === 'success';
    const totalTokens = normalizeNonNegativeInt(row.totalTokens);
    const latencyMs = normalizeNonNegativeInt(row.latencyMs);
    const latencyCount = latencyMs > 0 ? 1 : 0;
    const totalSummarySpend = resolveSummarySpend({
      estimatedCost: row.estimatedCost,
      totalTokens: row.totalTokens,
      platform: row.sitePlatform,
    });
    const totalSiteSpend = resolveSiteSpend({
      estimatedCost: row.estimatedCost,
      totalTokens: row.totalTokens,
      platform: row.sitePlatform,
    });
    const model = resolveModelName(row);
    const modelSpend = resolveModelSpend({
      estimatedCost: row.estimatedCost,
      totalTokens: row.totalTokens,
    });

    const siteDayKey = `${localDay}:${siteId}`;
    const siteDay = siteDayMap.get(siteDayKey) || {
      localDay,
      siteId,
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      totalTokens: 0,
      totalSummarySpend: 0,
      totalSiteSpend: 0,
      totalLatencyMs: 0,
      latencyCount: 0,
    };
    siteDay.totalCalls += 1;
    siteDay.successCalls += isSuccess ? 1 : 0;
    siteDay.failedCalls += isSuccess ? 0 : 1;
    siteDay.totalTokens += totalTokens;
    siteDay.totalSummarySpend += totalSummarySpend;
    siteDay.totalSiteSpend += totalSiteSpend;
    siteDay.totalLatencyMs += latencyMs;
    siteDay.latencyCount += latencyCount;
    siteDayMap.set(siteDayKey, siteDay);

    const siteHourKey = `${bucketStartUtc}:${siteId}`;
    const siteHour = siteHourMap.get(siteHourKey) || {
      bucketStartUtc,
      siteId,
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      totalTokens: 0,
      totalSummarySpend: 0,
      totalSiteSpend: 0,
      totalLatencyMs: 0,
      latencyCount: 0,
    };
    siteHour.totalCalls += 1;
    siteHour.successCalls += isSuccess ? 1 : 0;
    siteHour.failedCalls += isSuccess ? 0 : 1;
    siteHour.totalTokens += totalTokens;
    siteHour.totalSummarySpend += totalSummarySpend;
    siteHour.totalSiteSpend += totalSiteSpend;
    siteHour.totalLatencyMs += latencyMs;
    siteHour.latencyCount += latencyCount;
    siteHourMap.set(siteHourKey, siteHour);

    const modelDayKey = `${localDay}:${siteId}:${model}`;
    const modelDay = modelDayMap.get(modelDayKey) || {
      localDay,
      siteId,
      model,
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      totalTokens: 0,
      totalSpend: 0,
      totalLatencyMs: 0,
      latencyCount: 0,
    };
    modelDay.totalCalls += 1;
    modelDay.successCalls += isSuccess ? 1 : 0;
    modelDay.failedCalls += isSuccess ? 0 : 1;
    modelDay.totalTokens += totalTokens;
    modelDay.totalSpend += modelSpend;
    modelDay.totalLatencyMs += latencyMs;
    modelDay.latencyCount += latencyCount;
    modelDayMap.set(modelDayKey, modelDay);
  }

  return {
    siteDayRows: Array.from(siteDayMap.values()),
    siteHourRows: Array.from(siteHourMap.values()),
    modelDayRows: Array.from(modelDayMap.values()),
  };
}

async function upsertSiteDayUsage(tx: typeof db, row: SiteDayUsageDeltaRow, updatedAt: string) {
  const values = {
    localDay: row.localDay,
    siteId: row.siteId,
    totalCalls: row.totalCalls,
    successCalls: row.successCalls,
    failedCalls: row.failedCalls,
    totalTokens: row.totalTokens,
    totalSummarySpend: row.totalSummarySpend,
    totalSiteSpend: row.totalSiteSpend,
    totalLatencyMs: row.totalLatencyMs,
    latencyCount: row.latencyCount,
    updatedAt,
  };

  if (runtimeDbDialect === 'mysql') {
    await (tx.insert(schema.siteDayUsage).values(values) as any)
      .onDuplicateKeyUpdate({
        set: {
          totalCalls: sql`${schema.siteDayUsage.totalCalls} + ${row.totalCalls}`,
          successCalls: sql`${schema.siteDayUsage.successCalls} + ${row.successCalls}`,
          failedCalls: sql`${schema.siteDayUsage.failedCalls} + ${row.failedCalls}`,
          totalTokens: sql`${schema.siteDayUsage.totalTokens} + ${row.totalTokens}`,
          totalSummarySpend: sql`${schema.siteDayUsage.totalSummarySpend} + ${row.totalSummarySpend}`,
          totalSiteSpend: sql`${schema.siteDayUsage.totalSiteSpend} + ${row.totalSiteSpend}`,
          totalLatencyMs: sql`${schema.siteDayUsage.totalLatencyMs} + ${row.totalLatencyMs}`,
          latencyCount: sql`${schema.siteDayUsage.latencyCount} + ${row.latencyCount}`,
          updatedAt,
        },
      })
      .run();
    return;
  }

  await (tx.insert(schema.siteDayUsage).values(values) as any)
    .onConflictDoUpdate({
      target: [schema.siteDayUsage.localDay, schema.siteDayUsage.siteId],
      set: {
        totalCalls: sql`${schema.siteDayUsage.totalCalls} + ${row.totalCalls}`,
        successCalls: sql`${schema.siteDayUsage.successCalls} + ${row.successCalls}`,
        failedCalls: sql`${schema.siteDayUsage.failedCalls} + ${row.failedCalls}`,
        totalTokens: sql`${schema.siteDayUsage.totalTokens} + ${row.totalTokens}`,
        totalSummarySpend: sql`${schema.siteDayUsage.totalSummarySpend} + ${row.totalSummarySpend}`,
        totalSiteSpend: sql`${schema.siteDayUsage.totalSiteSpend} + ${row.totalSiteSpend}`,
        totalLatencyMs: sql`${schema.siteDayUsage.totalLatencyMs} + ${row.totalLatencyMs}`,
        latencyCount: sql`${schema.siteDayUsage.latencyCount} + ${row.latencyCount}`,
        updatedAt,
      },
    })
    .run();
}

async function upsertSiteHourUsage(tx: typeof db, row: SiteHourUsageDeltaRow, updatedAt: string) {
  const values = {
    bucketStartUtc: row.bucketStartUtc,
    siteId: row.siteId,
    totalCalls: row.totalCalls,
    successCalls: row.successCalls,
    failedCalls: row.failedCalls,
    totalTokens: row.totalTokens,
    totalSummarySpend: row.totalSummarySpend,
    totalSiteSpend: row.totalSiteSpend,
    totalLatencyMs: row.totalLatencyMs,
    latencyCount: row.latencyCount,
    updatedAt,
  };

  if (runtimeDbDialect === 'mysql') {
    await (tx.insert(schema.siteHourUsage).values(values) as any)
      .onDuplicateKeyUpdate({
        set: {
          totalCalls: sql`${schema.siteHourUsage.totalCalls} + ${row.totalCalls}`,
          successCalls: sql`${schema.siteHourUsage.successCalls} + ${row.successCalls}`,
          failedCalls: sql`${schema.siteHourUsage.failedCalls} + ${row.failedCalls}`,
          totalTokens: sql`${schema.siteHourUsage.totalTokens} + ${row.totalTokens}`,
          totalSummarySpend: sql`${schema.siteHourUsage.totalSummarySpend} + ${row.totalSummarySpend}`,
          totalSiteSpend: sql`${schema.siteHourUsage.totalSiteSpend} + ${row.totalSiteSpend}`,
          totalLatencyMs: sql`${schema.siteHourUsage.totalLatencyMs} + ${row.totalLatencyMs}`,
          latencyCount: sql`${schema.siteHourUsage.latencyCount} + ${row.latencyCount}`,
          updatedAt,
        },
      })
      .run();
    return;
  }

  await (tx.insert(schema.siteHourUsage).values(values) as any)
    .onConflictDoUpdate({
      target: [schema.siteHourUsage.bucketStartUtc, schema.siteHourUsage.siteId],
      set: {
        totalCalls: sql`${schema.siteHourUsage.totalCalls} + ${row.totalCalls}`,
        successCalls: sql`${schema.siteHourUsage.successCalls} + ${row.successCalls}`,
        failedCalls: sql`${schema.siteHourUsage.failedCalls} + ${row.failedCalls}`,
        totalTokens: sql`${schema.siteHourUsage.totalTokens} + ${row.totalTokens}`,
        totalSummarySpend: sql`${schema.siteHourUsage.totalSummarySpend} + ${row.totalSummarySpend}`,
        totalSiteSpend: sql`${schema.siteHourUsage.totalSiteSpend} + ${row.totalSiteSpend}`,
        totalLatencyMs: sql`${schema.siteHourUsage.totalLatencyMs} + ${row.totalLatencyMs}`,
        latencyCount: sql`${schema.siteHourUsage.latencyCount} + ${row.latencyCount}`,
        updatedAt,
      },
    })
    .run();
}

async function upsertModelDayUsage(tx: typeof db, row: ModelDayUsageDeltaRow, updatedAt: string) {
  const values = {
    localDay: row.localDay,
    siteId: row.siteId,
    model: row.model,
    totalCalls: row.totalCalls,
    successCalls: row.successCalls,
    failedCalls: row.failedCalls,
    totalTokens: row.totalTokens,
    totalSpend: row.totalSpend,
    totalLatencyMs: row.totalLatencyMs,
    latencyCount: row.latencyCount,
    updatedAt,
  };

  if (runtimeDbDialect === 'mysql') {
    await (tx.insert(schema.modelDayUsage).values(values) as any)
      .onDuplicateKeyUpdate({
        set: {
          totalCalls: sql`${schema.modelDayUsage.totalCalls} + ${row.totalCalls}`,
          successCalls: sql`${schema.modelDayUsage.successCalls} + ${row.successCalls}`,
          failedCalls: sql`${schema.modelDayUsage.failedCalls} + ${row.failedCalls}`,
          totalTokens: sql`${schema.modelDayUsage.totalTokens} + ${row.totalTokens}`,
          totalSpend: sql`${schema.modelDayUsage.totalSpend} + ${row.totalSpend}`,
          totalLatencyMs: sql`${schema.modelDayUsage.totalLatencyMs} + ${row.totalLatencyMs}`,
          latencyCount: sql`${schema.modelDayUsage.latencyCount} + ${row.latencyCount}`,
          updatedAt,
        },
      })
      .run();
    return;
  }

  await (tx.insert(schema.modelDayUsage).values(values) as any)
    .onConflictDoUpdate({
      target: [schema.modelDayUsage.localDay, schema.modelDayUsage.siteId, schema.modelDayUsage.model],
      set: {
        totalCalls: sql`${schema.modelDayUsage.totalCalls} + ${row.totalCalls}`,
        successCalls: sql`${schema.modelDayUsage.successCalls} + ${row.successCalls}`,
        failedCalls: sql`${schema.modelDayUsage.failedCalls} + ${row.failedCalls}`,
        totalTokens: sql`${schema.modelDayUsage.totalTokens} + ${row.totalTokens}`,
        totalSpend: sql`${schema.modelDayUsage.totalSpend} + ${row.totalSpend}`,
        totalLatencyMs: sql`${schema.modelDayUsage.totalLatencyMs} + ${row.totalLatencyMs}`,
        latencyCount: sql`${schema.modelDayUsage.latencyCount} + ${row.latencyCount}`,
        updatedAt,
      },
    })
    .run();
}

async function applyProjectionBatch(
  checkpoint: ProjectionCheckpointRow,
  rows: ProxyLogProjectionRow[],
): Promise<ProjectionCheckpointRow> {
  const lastRow = rows.at(-1);
  if (!lastRow) return checkpoint;

  const delta = buildProjectionBatchDelta(rows);
  const updatedAt = new Date().toISOString();
  const nextCheckpoint = {
    ...checkpoint,
    lastProxyLogId: lastRow.id,
    watermarkCreatedAt:
      typeof lastRow.createdAt === 'string'
        ? lastRow.createdAt
        : String(lastRow.createdAt || ''),
    recomputeFromId: checkpoint.recomputeFromId ?? null,
    recomputeRequestedAt: checkpoint.recomputeRequestedAt ?? null,
    leaseExpiresAt: checkpoint.leaseToken ? buildProjectionLeaseExpiry() : checkpoint.leaseExpiresAt,
    lastProjectedAt: updatedAt,
    lastSuccessfulAt: updatedAt,
    lastError: null,
    createdAt: checkpoint.createdAt ?? updatedAt,
  };

  await db.transaction(async (tx) => {
    for (const row of delta.siteDayRows) {
      await upsertSiteDayUsage(tx as typeof db, row, updatedAt);
    }
    for (const row of delta.siteHourRows) {
      await upsertSiteHourUsage(tx as typeof db, row, updatedAt);
    }
    for (const row of delta.modelDayRows) {
      await upsertModelDayUsage(tx as typeof db, row, updatedAt);
    }
    await writeProjectionCheckpoint(tx as typeof db, nextCheckpoint);
  });

  clearAnalyticsSnapshots();
  return {
    ...checkpoint,
    ...nextCheckpoint,
    updatedAt,
  };
}

async function applyPendingRecompute(checkpoint: ProjectionCheckpointRow) {
  const recomputeFromId = normalizeNonNegativeInt(checkpoint.recomputeFromId);
  if (recomputeFromId <= 0) return checkpoint;

  const affectedRow = await db
    .select({
      id: schema.proxyLogs.id,
      createdAt: schema.proxyLogs.createdAt,
    })
    .from(schema.proxyLogs)
    .where(gte(schema.proxyLogs.id, recomputeFromId))
    .orderBy(asc(schema.proxyLogs.id))
    .get();

  if (!affectedRow) {
    const nextCheckpoint = {
      ...checkpoint,
      recomputeFromId: null,
      recomputeRequestedAt: null,
      leaseExpiresAt: checkpoint.leaseToken ? buildProjectionLeaseExpiry() : checkpoint.leaseExpiresAt,
      lastProjectedAt: new Date().toISOString(),
    };
    await db.transaction(async (tx) => {
      await writeProjectionCheckpoint(tx as typeof db, nextCheckpoint as any);
    });
    return { ...checkpoint, ...nextCheckpoint };
  }

  const affectedDay = toLocalDayKeyFromStoredUtc(affectedRow.createdAt);
  const affectedDayStartUtc = toLocalDayStartUtcFromStoredUtc(affectedRow.createdAt);
  if (!affectedDay || !affectedDayStartUtc) {
    throw new Error('Failed to resolve recompute boundary for usage aggregates');
  }

  const restartRow = await db
    .select({
      id: schema.proxyLogs.id,
      createdAt: schema.proxyLogs.createdAt,
    })
    .from(schema.proxyLogs)
    .where(gte(schema.proxyLogs.createdAt, affectedDayStartUtc))
    .orderBy(asc(schema.proxyLogs.id))
    .get();

  const restartFromId = restartRow?.id || affectedRow.id;
  const nextCheckpoint = {
    ...checkpoint,
    lastProxyLogId: Math.max(0, restartFromId - 1),
    watermarkCreatedAt: null,
    recomputeFromId: null,
    recomputeRequestedAt: null,
    leaseExpiresAt: checkpoint.leaseToken ? buildProjectionLeaseExpiry() : checkpoint.leaseExpiresAt,
    lastProjectedAt: new Date().toISOString(),
  };

  await db.transaction(async (tx) => {
    await tx.delete(schema.siteDayUsage).where(gte(schema.siteDayUsage.localDay, affectedDay)).run();
    await tx.delete(schema.siteHourUsage).where(gte(schema.siteHourUsage.bucketStartUtc, affectedDayStartUtc)).run();
    await tx.delete(schema.modelDayUsage).where(gte(schema.modelDayUsage.localDay, affectedDay)).run();
    await writeProjectionCheckpoint(tx as typeof db, nextCheckpoint as any);
  });

  clearAnalyticsSnapshots();
  return { ...checkpoint, ...nextCheckpoint };
}

async function runUsageAggregationProjectionPassImpl(
  options: ProjectionPassOptions = {},
): Promise<ProjectionPassResult> {
  const lease = await tryAcquireProjectionLease();
  if (!lease) {
    const checkpoint = await readProjectionCheckpoint();
    return {
      processedLogs: 0,
      watermarkId: checkpoint.lastProxyLogId,
      recomputed: false,
    };
  }

  try {
    let checkpoint: ProjectionCheckpointRow = {
      ...(await readProjectionCheckpoint()),
      leaseOwner: lease.owner,
      leaseToken: lease.token,
      leaseExpiresAt: lease.expiresAt,
    };
    const hadPendingRecompute = normalizeNonNegativeInt(checkpoint.recomputeFromId) > 0;
    if (hadPendingRecompute) {
      checkpoint = await applyPendingRecompute(checkpoint);
    }

    let processedLogs = 0;
    const maxBatches = Math.max(
      1,
      Math.trunc(options.maxBatches || PROJECTION_MAX_BATCHES_PER_PASS),
    );

    for (let index = 0; index < maxBatches; index += 1) {
      const rows = await fetchProjectionBatch(checkpoint.lastProxyLogId, PROJECTION_BATCH_SIZE);
      if (rows.length <= 0) {
        break;
      }

      checkpoint = await applyProjectionBatch(checkpoint, rows);
      processedLogs += rows.length;

      if (rows.length < PROJECTION_BATCH_SIZE) {
        break;
      }
    }

    await releaseProjectionLease(lease);
    return {
      processedLogs,
      watermarkId: checkpoint.lastProxyLogId,
      recomputed: hadPendingRecompute,
    };
  } catch (error) {
    await releaseProjectionLease(lease, { error });
    throw error;
  }
}

export async function runUsageAggregationProjectionPass(
  options: ProjectionPassOptions = {},
): Promise<ProjectionPassResult> {
  if (projectionInFlight) {
    return projectionInFlight;
  }

  projectionInFlight = runUsageAggregationProjectionPassImpl(options).finally(() => {
    projectionInFlight = null;
  });
  return projectionInFlight;
}

export async function requestUsageAggregatesRecompute(fromLogId = 1): Promise<void> {
  const checkpoint = await readProjectionCheckpoint();
  const normalizedFromId = Math.max(1, Math.trunc(fromLogId || 1));
  const nextFromId = checkpoint.recomputeFromId && checkpoint.recomputeFromId > 0
    ? Math.min(checkpoint.recomputeFromId, normalizedFromId)
    : normalizedFromId;

  await db.transaction(async (tx) => {
    await writeProjectionCheckpoint(tx as typeof db, {
      ...checkpoint,
      lastProxyLogId: checkpoint.lastProxyLogId,
      recomputeFromId: nextFromId,
      recomputeRequestedAt: new Date().toISOString(),
      lastProjectedAt: checkpoint.lastProjectedAt,
    } as any);
  });
}

export function startUsageAggregationProjectorScheduler() {
  if (projectionTimer) return;
  void runUsageAggregationProjectionPass();
  projectionTimer = setInterval(() => {
    void runUsageAggregationProjectionPass();
  }, PROJECTION_INTERVAL_MS);
}

export async function stopUsageAggregationProjectorScheduler() {
  if (projectionTimer) {
    clearInterval(projectionTimer);
    projectionTimer = null;
  }
  if (projectionInFlight) {
    await projectionInFlight;
  }
}

export async function __resetUsageAggregationProjectorForTests() {
  await stopUsageAggregationProjectorScheduler();
}
