import { beforeEach, describe, expect, it, vi } from 'vitest';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const analyticsProjectionCheckpoints = sqliteTable('analytics_projection_checkpoints', {
  projectorKey: text('projector_key').primaryKey(),
  timeZone: text('time_zone'),
  lastProxyLogId: integer('last_proxy_log_id'),
  watermarkCreatedAt: text('watermark_created_at'),
  recomputeFromId: integer('recompute_from_id'),
  recomputeRequestedAt: text('recompute_requested_at'),
  recomputeReason: text('recompute_reason'),
  recomputeStartedAt: text('recompute_started_at'),
  recomputeCompletedAt: text('recompute_completed_at'),
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  lastProjectedAt: text('last_projected_at'),
  lastSuccessfulAt: text('last_successful_at'),
  lastError: text('last_error'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

const proxyLogs = sqliteTable('proxy_logs', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id'),
  createdAt: text('created_at'),
  status: text('status'),
  latencyMs: integer('latency_ms'),
  totalTokens: integer('total_tokens'),
  estimatedCost: real('estimated_cost'),
  modelActual: text('model_actual'),
  modelRequested: text('model_requested'),
});

const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey(),
  siteId: integer('site_id'),
});

const sites = sqliteTable('sites', {
  id: integer('id').primaryKey(),
  platform: text('platform'),
});

const siteDayUsage = sqliteTable('site_day_usage', {
  localDay: text('local_day'),
  siteId: integer('site_id'),
  totalCalls: integer('total_calls'),
  successCalls: integer('success_calls'),
  failedCalls: integer('failed_calls'),
  totalTokens: integer('total_tokens'),
  totalSummarySpend: real('total_summary_spend'),
  totalSiteSpend: real('total_site_spend'),
  totalLatencyMs: integer('total_latency_ms'),
  latencyCount: integer('latency_count'),
  updatedAt: text('updated_at'),
});

const siteHourUsage = sqliteTable('site_hour_usage', {
  bucketStartUtc: text('bucket_start_utc'),
  siteId: integer('site_id'),
  totalCalls: integer('total_calls'),
  successCalls: integer('success_calls'),
  failedCalls: integer('failed_calls'),
  totalTokens: integer('total_tokens'),
  totalSummarySpend: real('total_summary_spend'),
  totalSiteSpend: real('total_site_spend'),
  totalLatencyMs: integer('total_latency_ms'),
  latencyCount: integer('latency_count'),
  updatedAt: text('updated_at'),
});

const modelDayUsage = sqliteTable('model_day_usage', {
  localDay: text('local_day'),
  siteId: integer('site_id'),
  model: text('model'),
  totalCalls: integer('total_calls'),
  successCalls: integer('success_calls'),
  failedCalls: integer('failed_calls'),
  totalTokens: integer('total_tokens'),
  totalSpend: real('total_spend'),
  totalLatencyMs: integer('total_latency_ms'),
  latencyCount: integer('latency_count'),
  updatedAt: text('updated_at'),
});

const schema = {
  analyticsProjectionCheckpoints,
  proxyLogs,
  accounts,
  sites,
  siteDayUsage,
  siteHourUsage,
  modelDayUsage,
};

type MockState = {
  checkpoint: Record<string, unknown> | null;
  proxyRows: Array<Record<string, unknown>>;
  siteDayRows: Array<Record<string, unknown>>;
  siteHourRows: Array<Record<string, unknown>>;
  modelDayRows: Array<Record<string, unknown>>;
  onDuplicateKeyUpdateTables: string[];
};

const state: MockState = {
  checkpoint: null,
  proxyRows: [],
  siteDayRows: [],
  siteHourRows: [],
  modelDayRows: [],
  onDuplicateKeyUpdateTables: [],
};

function resetMockState() {
  state.checkpoint = null;
  state.proxyRows = [];
  state.siteDayRows = [];
  state.siteHourRows = [];
  state.modelDayRows = [];
  state.onDuplicateKeyUpdateTables = [];
}

function resolveTableName(table: unknown): string {
  if (table === analyticsProjectionCheckpoints) return 'analytics_projection_checkpoints';
  if (table === proxyLogs) return 'proxy_logs';
  if (table === siteDayUsage) return 'site_day_usage';
  if (table === siteHourUsage) return 'site_hour_usage';
  if (table === modelDayUsage) return 'model_day_usage';
  return 'unknown';
}

function applyInsert(
  table: unknown,
  values: Record<string, unknown> | Array<Record<string, unknown>>,
  onDuplicateSet: Record<string, unknown> | null,
) {
  if (table === analyticsProjectionCheckpoints) {
    if (!state.checkpoint) {
      state.checkpoint = { ...(values as Record<string, unknown>) };
      return;
    }
    if (onDuplicateSet) {
      state.checkpoint = { ...state.checkpoint, ...onDuplicateSet };
    }
    return;
  }

  if (table === siteDayUsage) {
    state.siteDayRows.push({ ...(values as Record<string, unknown>) });
    return;
  }

  if (table === siteHourUsage) {
    state.siteHourRows.push({ ...(values as Record<string, unknown>) });
    return;
  }

  if (table === modelDayUsage) {
    state.modelDayRows.push({ ...(values as Record<string, unknown>) });
  }
}

function makeInsertChain(table: unknown) {
  let values: Record<string, unknown> | Array<Record<string, unknown>> = {};
  let onDuplicateSet: Record<string, unknown> | null = null;

  const chain = {
    values(nextValues: Record<string, unknown> | Array<Record<string, unknown>>) {
      values = nextValues;
      return chain;
    },
    onDuplicateKeyUpdate(input: { set: Record<string, unknown> }) {
      state.onDuplicateKeyUpdateTables.push(resolveTableName(table));
      onDuplicateSet = input.set;
      return chain;
    },
    run: vi.fn(async () => {
      applyInsert(table, values, onDuplicateSet);
      return { changes: 1 };
    }),
  };

  return chain;
}

function makeSelectChain() {
  let fromTable: unknown = null;

  const chain = {
    from(table: unknown) {
      fromTable = table;
      return chain;
    },
    leftJoin() {
      return chain;
    },
    where() {
      return chain;
    },
    orderBy() {
      return chain;
    },
    limit() {
      return chain;
    },
    async get() {
      if (fromTable === analyticsProjectionCheckpoints) {
        return state.checkpoint ? { ...state.checkpoint } : undefined;
      }
      if (fromTable === proxyLogs) {
        return state.proxyRows[0] ? { ...state.proxyRows[0] } : undefined;
      }
      return undefined;
    },
    async all() {
      if (fromTable === proxyLogs) {
        return state.proxyRows.map((row) => ({ ...row }));
      }
      if (fromTable === siteDayUsage) {
        return state.siteDayRows.map((row) => ({ ...row }));
      }
      if (fromTable === siteHourUsage) {
        return state.siteHourRows.map((row) => ({ ...row }));
      }
      if (fromTable === modelDayUsage) {
        return state.modelDayRows.map((row) => ({ ...row }));
      }
      return [];
    },
  };

  return chain;
}

function makeUpdateChain(table: unknown) {
  let setValues: Record<string, unknown> = {};

  const chain = {
    set(nextValues: Record<string, unknown>) {
      setValues = nextValues;
      return chain;
    },
    where() {
      return chain;
    },
    run: vi.fn(async () => {
      if (table === analyticsProjectionCheckpoints && state.checkpoint) {
        state.checkpoint = { ...state.checkpoint, ...setValues };
        return { changes: 1 };
      }
      return { changes: 0 };
    }),
  };

  return chain;
}

const db = {
  insert: vi.fn((table: unknown) => makeInsertChain(table)),
  select: vi.fn(() => makeSelectChain()),
  update: vi.fn((table: unknown) => makeUpdateChain(table)),
  transaction: vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db)),
};

vi.mock('../db/index.js', () => ({
  db,
  runtimeDbDialect: 'mysql',
  schema,
}));

vi.mock('./modelPricingService.js', () => ({
  fallbackTokenCost: vi.fn(() => 0),
}));

vi.mock('./localTimeService.js', () => ({
  getLocalRangeStartDayKey: vi.fn(() => '2026-04-08'),
  getResolvedTimeZone: vi.fn(() => 'Local'),
  toLocalDayKeyFromStoredUtc: vi.fn(() => '2026-04-08'),
  toLocalDayStartUtcFromStoredUtc: vi.fn(() => '2026-04-08 00:00:00'),
  toLocalHourStartUtcFromStoredUtc: vi.fn(() => '2026-04-08 02:00:00'),
}));

vi.mock('./snapshotCacheService.js', () => ({
  clearSnapshotCache: vi.fn(),
}));

type UsageAggregationModule = typeof import('./usageAggregationService.js');

describe('usageAggregationService mysql conflict handling', () => {
  let usageAggregationModule: UsageAggregationModule;

  beforeEach(async () => {
    resetMockState();
    vi.resetModules();
    usageAggregationModule = await import('./usageAggregationService.js');
    await usageAggregationModule.__resetUsageAggregationProjectorForTests();
  });

  it('uses mysql duplicate-key upserts for checkpoint and aggregate writes', async () => {
    state.proxyRows = [{
      id: 1,
      createdAt: '2026-04-08 02:10:00',
      status: 'success',
      latencyMs: 120,
      totalTokens: 100,
      estimatedCost: 0.2,
      modelActual: 'gpt-5',
      modelRequested: 'gpt-5',
      siteId: 7,
      sitePlatform: 'new-api',
    }];

    const result = await usageAggregationModule.runUsageAggregationProjectionPass();

    expect(result).toEqual({
      processedLogs: 1,
      watermarkId: 1,
      recomputed: false,
    });
    expect(state.onDuplicateKeyUpdateTables).toEqual([
      'analytics_projection_checkpoints',
      'site_day_usage',
      'site_hour_usage',
      'model_day_usage',
      'analytics_projection_checkpoints',
    ]);
    expect(state.siteDayRows).toEqual([
      expect.objectContaining({
        localDay: '2026-04-08',
        siteId: 7,
        totalCalls: 1,
        successCalls: 1,
        failedCalls: 0,
        totalTokens: 100,
      }),
    ]);
    expect(state.siteHourRows).toEqual([
      expect.objectContaining({
        bucketStartUtc: '2026-04-08 02:00:00',
        siteId: 7,
        totalCalls: 1,
      }),
    ]);
    expect(state.modelDayRows).toEqual([
      expect.objectContaining({
        localDay: '2026-04-08',
        siteId: 7,
        model: 'gpt-5',
        totalCalls: 1,
      }),
    ]);
    expect(state.checkpoint).toEqual(expect.objectContaining({
      projectorKey: 'usage-aggregates-v1',
      lastProxyLogId: 1,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
    }));
  });

  it('uses mysql duplicate-key upsert when recompute requests persist checkpoint state', async () => {
    await usageAggregationModule.requestUsageAggregatesRecompute(7);

    expect(state.onDuplicateKeyUpdateTables).toEqual([
      'analytics_projection_checkpoints',
    ]);
    expect(state.checkpoint).toEqual(expect.objectContaining({
      projectorKey: 'usage-aggregates-v1',
      lastProxyLogId: 0,
      recomputeFromId: 7,
    }));
  });
});
