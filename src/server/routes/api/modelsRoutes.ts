import type { FastifyInstance } from 'fastify';
import {
  accumulateThroughputSample,
  createThroughputAggregate,
  finalizeThroughputTps,
  getThroughputSampleCount,
  type ThroughputAggregate,
} from '../../services/marketplaceThroughput.js';
import { db, schema } from '../../db/index.js';
import { and, eq, gte, sql } from 'drizzle-orm';
import { refreshModelsForAccount } from '../../services/modelService.js';
import * as routeRefreshWorkflow from '../../services/routeRefreshWorkflow.js';
import { lookupModelsDevCapabilities } from '../../services/modelCapabilitiesService.js';
import {
  ensureSiteContextCapabilityLoaded,
  lookupSiteContextLimitForNames,
  lookupSiteContextObservedMaxPrompt,
} from '../../services/siteContextCapabilityService.js';
import {
  fetchModelPricingCatalog,
} from '../../services/modelPricingService.js';
import {
  probeSingleModelAvailability,
  probeSingleModelAvailabilityStream,
} from '../../services/modelMarketplaceProbeService.js';
import { getUpstreamModelDescriptionsCached } from '../../services/upstreamModelDescriptionService.js';
import {getRunningTaskByDedupeKey, startBackgroundTask} from '../../services/backgroundTaskService.js';
import { requiresManagedAccountTokens } from '../../services/accountExtraConfig.js';
import { ACCOUNT_TOKEN_VALUE_STATUS_READY } from '../../services/accountTokenService.js';
import { canonicalizeModelName } from '../../shared/modelCanonicalization.js';
import {
  isModelDisabledForSite,
  loadSiteDisabledModelsIndex,
} from '../../services/siteDisabledModels.js';
import {getLocalRangeStartUtc} from '../../services/localTimeService.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import {
  parseBooleanFlag,
  isRecord,
  mapWithConcurrency,
} from './stats.pure.js';


/**
 * Models marketplace, token-candidate, and probe endpoints, split out of
 * statsRoutes. Registered by direct call so the Fastify encapsulation context
 * and auth hooks stay identical.
 */
const MODELS_MARKETPLACE_BASE_TTL_MS = 15_000;
const MODELS_MARKETPLACE_PRICING_TTL_MS = 90_000;

const limitModelTokenCandidatesRead = createRateLimitGuard({
  bucket: 'models-token-candidates-read',
  max: 30,
  windowMs: 60_000,
});

const limitModelsMarketplaceRead = createRateLimitGuard({
  bucket: 'models-marketplace-read',
  max: 30,
  windowMs: 60_000,
});

const limitModelProbe = createRateLimitGuard({
  bucket: 'models-probe',
  max: 20,
  windowMs: 60_000,
});

const limitModelCheck = createRateLimitGuard({
  bucket: 'models-check',
  max: 30,
  windowMs: 60_000,
});

type ModelsMarketplaceCacheEntry = {
  expiresAt: number;
  models: any[];
};

const modelsMarketplaceCache = new Map<
  'base' | 'pricing',
  ModelsMarketplaceCacheEntry
>();

function readModelsMarketplaceCache(includePricing: boolean): any[] | null {
  const key = includePricing ? 'pricing' : 'base';
  const cached = modelsMarketplaceCache.get(key);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    modelsMarketplaceCache.delete(key);
    return null;
  }
  return cached.models;
}

function writeModelsMarketplaceCache(
  includePricing: boolean,
  models: any[],
): void {
  const ttl = includePricing
    ? MODELS_MARKETPLACE_PRICING_TTL_MS
    : MODELS_MARKETPLACE_BASE_TTL_MS;
  const key = includePricing ? 'pricing' : 'base';
  modelsMarketplaceCache.set(key, {
    expiresAt: Date.now() + ttl,
    models,
  });
}

export function clearModelsMarketplaceCache(): void {
  modelsMarketplaceCache.clear();
}

export function registerModelsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { refresh?: string; includePricing?: string } }>(
    '/api/models/marketplace',
    { preHandler: [limitModelsMarketplaceRead] },
    async (request) => {
      const refreshRequested = parseBooleanFlag(request.query.refresh);
      const includePricing = parseBooleanFlag(request.query.includePricing);

      let refreshQueued = false;
      let refreshReused = false;
      let refreshJobId: string | null = null;

      if (refreshRequested) {
        modelsMarketplaceCache.clear();
        const { task, reused } = startBackgroundTask(
          {
            type: 'model',
            title: '刷新模型广场数据',
            dedupeKey: 'refresh-models-and-rebuild-routes',
            notifyOnFailure: true,
            successMessage: (currentTask) => {
              const rebuild = (currentTask.result as any)?.rebuild;
              if (!rebuild) return '模型广场刷新已完成';
              return `模型广场刷新完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
            },
            failureMessage: (currentTask) =>
              `模型广场刷新失败：${currentTask.error || 'unknown error'}`,
          },
          async () => {
            try {
              return await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
            } finally {
              // Availability/routes were rewritten under the running task: any
              // marketplace payload cached mid-run is pre-refresh data. Drop it
              // so the next GET rebuilds from the refreshed DB (success OR
              // failure — a partial pass also leaves stale rows behind).
              modelsMarketplaceCache.clear();
            }
          },
        );
        refreshQueued = !reused;
        refreshReused = reused;
        refreshJobId = task.id;
      }
      const runningRefreshTask = getRunningTaskByDedupeKey(
        'refresh-models-and-rebuild-routes',
      );
      if (!refreshJobId && runningRefreshTask)
        refreshJobId = runningRefreshTask.id;

      if (!refreshRequested) {
        const cachedModels = readModelsMarketplaceCache(includePricing);
        if (cachedModels) {
          return {
            models: cachedModels,
            meta: {
              refreshRequested,
              refreshQueued,
              refreshReused,
              refreshRunning: !!runningRefreshTask,
              refreshJobId,
              includePricing,
              cacheHit: true,
            },
          };
        }
      }

      const availability = await db
        .select()
        .from(schema.tokenModelAvailability)
        .innerJoin(
          schema.accountTokens,
          eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id),
        )
        .innerJoin(
          schema.accounts,
          eq(schema.accountTokens.accountId, schema.accounts.id),
        )
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.tokenModelAvailability.available, true),
            eq(schema.accountTokens.enabled, true),
            eq(
              schema.accountTokens.valueStatus,
              ACCOUNT_TOKEN_VALUE_STATUS_READY,
            ),
            eq(schema.accounts.status, 'active'),
            eq(schema.sites.status, 'active'),
          ),
        )
        .all();
      const accountAvailability = await db
        .select()
        .from(schema.modelAvailability)
        .innerJoin(
          schema.accounts,
          eq(schema.modelAvailability.accountId, schema.accounts.id),
        )
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.modelAvailability.available, true),
            eq(schema.accounts.status, 'active'),
            eq(schema.sites.status, 'active'),
          ),
        )
        .all();

      const disabledModelsIndex = await loadSiteDisabledModelsIndex();

      const last7d = getLocalRangeStartUtc(7);

      // SQL pushdown: aggregate simple per-model stats (total, success, avg
      // latency, avg first-byte) without reading every raw log row into Node.
      const modelLogAggregateRows = await db
        .select({
          modelActual: schema.proxyLogs.modelActual,
          modelRequested: schema.proxyLogs.modelRequested,
          status: schema.proxyLogs.status,
          total: sql<number>`count(*)`,
          successCount: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
          avgLatencyMs: sql<number>`coalesce(avg(case when ${schema.proxyLogs.status} = 'success' then ${schema.proxyLogs.latencyMs} end), 0)`,
          firstByteSum: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' and ${schema.proxyLogs.firstByteLatencyMs} is not null then ${schema.proxyLogs.firstByteLatencyMs} end), 0)`,
          firstByteCount: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' and ${schema.proxyLogs.firstByteLatencyMs} is not null then 1 end), 0)`,
        })
        .from(schema.proxyLogs)
        .where(gte(schema.proxyLogs.createdAt, last7d))
        .groupBy(schema.proxyLogs.modelActual, schema.proxyLogs.modelRequested, schema.proxyLogs.status)
        .all();

      type ModelLogStats = {
        success: number;
        total: number;
        totalLatency: number;
        firstByteSum: number;
        firstByteCount: number;
        throughput: ThroughputAggregate;
      };

      const modelLogStats: Record<string, ModelLogStats> = {};

      for (const row of modelLogAggregateRows) {
        const rawModel = row.modelActual || row.modelRequested || '';
        if (!rawModel) continue;
        const model = canonicalizeModelName(rawModel) || rawModel;
        if (!modelLogStats[model]) {
          modelLogStats[model] = {
            success: 0,
            total: 0,
            totalLatency: 0,
            firstByteSum: 0,
            firstByteCount: 0,
            throughput: createThroughputAggregate(),
          };
        }
        const stats = modelLogStats[model];
        stats.total += Number(row.total || 0);
        if (row.status === 'success') {
          stats.success += Number(row.successCount || 0);
          const avgLat = Number(row.avgLatencyMs || 0);
          if (Number.isFinite(avgLat) && avgLat >= 0) {
            stats.totalLatency += avgLat * Number(row.successCount || 0);
          }
          stats.firstByteSum += Number(row.firstByteSum || 0);
          stats.firstByteCount += Number(row.firstByteCount || 0);
        }
      }

      // Throughput: targeted query — only success+stream rows, 4 columns.
      // Returns far fewer rows than the full 7-day scan.
      const throughputRows = await db
        .select({
          modelActual: schema.proxyLogs.modelActual,
          modelRequested: schema.proxyLogs.modelRequested,
          latencyMs: schema.proxyLogs.latencyMs,
          firstByteLatencyMs: schema.proxyLogs.firstByteLatencyMs,
          completionTokens: schema.proxyLogs.completionTokens,
        })
        .from(schema.proxyLogs)
        .where(
          and(
            gte(schema.proxyLogs.createdAt, last7d),
            eq(schema.proxyLogs.status, 'success'),
            eq(schema.proxyLogs.isStream, true),
          ),
        )
        .all();

      for (const row of throughputRows) {
        const rawModel = row.modelActual || row.modelRequested || '';
        if (!rawModel) continue;
        const model = canonicalizeModelName(rawModel) || rawModel;
        const stats = modelLogStats[model];
        if (!stats) continue;
        accumulateThroughputSample(stats.throughput, {
          status: 'success',
          latencyMs: row.latencyMs,
          firstByteLatencyMs: row.firstByteLatencyMs,
          completionTokens: row.completionTokens,
          isStream: true,
        });
      }

      type ModelMetadataAggregate = {
        description: string | null;
        tags: Set<string>;
        supportedEndpointTypes: Set<string>;
        pricingSources: Array<{
          siteId: number;
          siteName: string;
          siteUrl: string;
          accountId: number;
          username: string | null;
          ownerBy: string | null;
          enableGroups: string[];
          groupPricing: Record<
            string,
            {
              quotaType: number;
              inputPerMillion?: number;
              outputPerMillion?: number;
              perCallInput?: number;
              perCallOutput?: number;
              perCallTotal?: number;
            }
          >;
        }>;
      };

      const modelMetadataMap = new Map<string, ModelMetadataAggregate>();
      if (includePricing) {
        const activeAccountRows = await db
          .select()
          .from(schema.accounts)
          .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .where(
            and(
              eq(schema.accounts.status, 'active'),
              eq(schema.sites.status, 'active'),
            ),
          )
          .all();

        const metadataResults = await mapWithConcurrency(
          activeAccountRows,
          6,
          async (row: any) => {
            const catalog = await fetchModelPricingCatalog({
              site: {
                id: row.sites.id,
                url: row.sites.url,
                platform: row.sites.platform,
              },
              account: {
                id: row.accounts.id,
                accessToken: row.accounts.accessToken,
                apiToken: row.accounts.apiToken,
              },
              modelName: '__metadata__',
              totalTokens: 0,
            });

            return {
              account: row.accounts,
              site: row.sites,
              catalog,
            };
          },
        );

        for (const result of metadataResults) {
          if (!result.catalog) continue;

          for (const model of result.catalog.models) {
            const key = (canonicalizeModelName(model.modelName) || model.modelName).toLowerCase();
            if (!modelMetadataMap.has(key)) {
              modelMetadataMap.set(key, {
                description: null,
                tags: new Set<string>(),
                supportedEndpointTypes: new Set<string>(),
                pricingSources: [],
              });
            }

            const aggregate = modelMetadataMap.get(key)!;
            if (!aggregate.description && model.modelDescription) {
              aggregate.description = model.modelDescription;
            }

            for (const tag of model.tags) aggregate.tags.add(tag);
            for (const endpointType of model.supportedEndpointTypes) {
              aggregate.supportedEndpointTypes.add(endpointType);
            }

            aggregate.pricingSources.push({
              siteId: result.site.id,
              siteName: result.site.name,
              siteUrl: result.site.url,
              accountId: result.account.id,
              username: result.account.username,
              ownerBy: model.ownerBy,
              enableGroups: model.enableGroups,
              groupPricing: model.groupPricing,
            });
          }
        }
      }

      const modelMap: Record<
        string,
        {
          name: string;
          accountsById: Map<
            number,
            {
              id: number;
              site: string;
              siteId: number;
              siteUrl: string;
              username: string | null;
              latency: number | null;
              connectivity: boolean | null;
              checkedAt: string | null;
              unitCost: number | null;
              balance: number;
              sourceModels: string[];
              tokens: Array<{ id: number; name: string; isDefault: boolean }>;
              contextLimit?: number | null;
              contextSource?: 'error' | 'usage' | 'manual' | null;
              contextObservedMaxPrompt?: number | null;
            }
          >;
        }
      > = {};

      for (const row of availability) {
        const m = row.token_model_availability;
        const t = row.account_tokens;
        const a = row.accounts;
        const s = row.sites;
        if (
          !m.available ||
          !t.enabled ||
          a.status !== 'active' ||
          s.status !== 'active'
        )
          continue;

        const sourceModel = String(m.modelName || '').trim();
        if (!sourceModel) continue;
        if (isModelDisabledForSite(disabledModelsIndex, s.id, sourceModel, a.id)) continue;
        const canonicalName = canonicalizeModelName(sourceModel) || sourceModel;
        if (!modelMap[canonicalName]) {
          modelMap[canonicalName] = {
            name: canonicalName,
            accountsById: new Map(),
          };
        }

        const existingAccount = modelMap[canonicalName].accountsById.get(a.id);
        if (!existingAccount) {
          modelMap[canonicalName].accountsById.set(a.id, {
            id: a.id,
            site: s.name,
            siteId: s.id,
            siteUrl: s.url,
            username: a.username,
            latency: m.latencyMs,
            connectivity: (m as any).connectivity == null ? null : !!(m as any).connectivity,
            checkedAt: m.checkedAt || null,
            unitCost: a.unitCost,
            balance: a.balance || 0,
            sourceModels: [sourceModel],
            tokens: [{ id: t.id, name: t.name, isDefault: !!t.isDefault }],
          });
        } else {
          if (!existingAccount.sourceModels.includes(sourceModel)) {
            existingAccount.sourceModels.push(sourceModel);
          }
          const nextLatency = (() => {
            if (existingAccount.latency == null) return m.latencyMs;
            if (m.latencyMs == null) return existingAccount.latency;
            return Math.min(existingAccount.latency, m.latencyMs);
          })();
          existingAccount.latency = nextLatency;
          // Prefer more recently checked connectivity signal.
          const incomingCheckedAt = m.checkedAt || null;
          if (incomingCheckedAt && (!existingAccount.checkedAt || incomingCheckedAt >= existingAccount.checkedAt)) {
            existingAccount.connectivity = (m as any).connectivity == null ? existingAccount.connectivity : !!(m as any).connectivity;
            existingAccount.checkedAt = incomingCheckedAt;
          } else if (existingAccount.connectivity == null && (m as any).connectivity != null) {
            existingAccount.connectivity = !!(m as any).connectivity;
            existingAccount.checkedAt = incomingCheckedAt || existingAccount.checkedAt;
          }
          if (!existingAccount.tokens.some((token) => token.id === t.id)) {
            existingAccount.tokens.push({
              id: t.id,
              name: t.name,
              isDefault: !!t.isDefault,
            });
          }
        }
      }

      for (const row of accountAvailability) {
        const m = row.model_availability;
        const a = row.accounts;
        const s = row.sites;
        if (!m.available || a.status !== 'active' || s.status !== 'active')
          continue;

        const sourceModel = String(m.modelName || '').trim();
        if (!sourceModel) continue;
        if (isModelDisabledForSite(disabledModelsIndex, s.id, sourceModel, a.id)) continue;
        const canonicalName = canonicalizeModelName(sourceModel) || sourceModel;
        if (!modelMap[canonicalName]) {
          modelMap[canonicalName] = {
            name: canonicalName,
            accountsById: new Map(),
          };
        }

        const existingAccount = modelMap[canonicalName].accountsById.get(a.id);
        if (!existingAccount) {
          modelMap[canonicalName].accountsById.set(a.id, {
            id: a.id,
            site: s.name,
            siteId: s.id,
            siteUrl: s.url,
            username: a.username,
            latency: m.latencyMs,
            connectivity: (m as any).connectivity == null ? null : !!(m as any).connectivity,
            checkedAt: m.checkedAt || null,
            unitCost: a.unitCost,
            balance: a.balance || 0,
            sourceModels: [sourceModel],
            tokens: [],
          });
          continue;
        }
        if (!existingAccount.sourceModels.includes(sourceModel)) {
          existingAccount.sourceModels.push(sourceModel);
        }

        const nextLatency = (() => {
          if (existingAccount.latency == null) return m.latencyMs;
          if (m.latencyMs == null) return existingAccount.latency;
          return Math.min(existingAccount.latency, m.latencyMs);
        })();
        existingAccount.latency = nextLatency;
        const incomingCheckedAt = m.checkedAt || null;
        if (incomingCheckedAt && (!existingAccount.checkedAt || incomingCheckedAt >= existingAccount.checkedAt)) {
          existingAccount.connectivity = (m as any).connectivity == null ? existingAccount.connectivity : !!(m as any).connectivity;
          existingAccount.checkedAt = incomingCheckedAt;
        } else if (existingAccount.connectivity == null && (m as any).connectivity != null) {
          existingAccount.connectivity = !!(m as any).connectivity;
          existingAccount.checkedAt = incomingCheckedAt || existingAccount.checkedAt;
        }
      }

      // Drop models that lost every supplier after site-disabled filtering.
      for (const [name, entry] of Object.entries(modelMap)) {
        if (entry.accountsById.size === 0) {
          delete modelMap[name];
        }
      }

      // Context capability (per site×model): attach the learned effective
      // window + evidence source so the marketplace can show it per site row.
      await ensureSiteContextCapabilityLoaded();
      for (const entry of Object.values(modelMap)) {
        for (const account of entry.accountsById.values()) {
          const modelNames = [entry.name, ...account.sourceModels];
          const contextHit = lookupSiteContextLimitForNames(account.siteId, modelNames);
          account.contextLimit = contextHit ? contextHit.limit : null;
          account.contextSource = contextHit ? contextHit.source : null;
          // Lower bound may exist without any cap (successes only, no overflow
          // yet) — keep it visible instead of collapsing to null.
          account.contextObservedMaxPrompt = lookupSiteContextObservedMaxPrompt(account.siteId, modelNames)
            ?? (contextHit ? (contextHit.observedMaxPrompt ?? null) : null);
        }
      }

      let upstreamDescriptionMap = new Map<string, string>();
      if (includePricing) {
        const hasMissingDescription = Object.keys(modelMap).some(
          (modelName) => {
            const metadata = modelMetadataMap.get(modelName.toLowerCase());
            return !metadata?.description;
          },
        );
        if (hasMissingDescription) {
          upstreamDescriptionMap = await getUpstreamModelDescriptionsCached();
        }
      }

      const models = Object.values(modelMap).map((m) => {
        const logStats = modelLogStats[m.name];
        const accounts = Array.from(m.accountsById.values()).map((account) => ({
          ...account,
          sourceModels: [...account.sourceModels].sort((a, b) => a.localeCompare(b)),
        }));
        // Average only over accounts with a known probe: counting never-probed
        // accounts as 0ms fabricated "fast" averages (680ms + null → 340ms).
        const knownLatencies = accounts
          .map((a) => a.latency)
          .filter((latency): latency is number => Number.isFinite(latency) && latency != null);
        const avgLatency = knownLatencies.length > 0
          ? knownLatencies.reduce((sum, latency) => sum + latency, 0) / knownLatencies.length
          : null;
        const metadata = modelMetadataMap.get(m.name.toLowerCase());
        const fallbackDescription = metadata?.description
          ? null
          : upstreamDescriptionMap.get(m.name.toLowerCase()) || null;
        const avgFirstByteMs = logStats && logStats.firstByteCount > 0
          ? Math.round(logStats.firstByteSum / logStats.firstByteCount)
          : null;
        const avgThroughputTps = logStats
          ? finalizeThroughputTps(logStats.throughput)
          : null;
        const throughputSampleCount = logStats
          ? getThroughputSampleCount(logStats.throughput)
          : 0;
        return {
          name: m.name,
          accountCount: accounts.length,
          tokenCount: accounts.reduce(
            (sum, account) => sum + account.tokens.length,
            0,
          ),
          avgLatency: avgLatency == null ? null : Math.round(avgLatency),
          avgFirstByteMs,
          avgThroughputTps,
          throughputSampleCount,
          successRate: logStats
            ? Math.round((logStats.success / logStats.total) * 1000) / 10
            : null,
          description: metadata?.description || fallbackDescription,
          tags: metadata
            ? Array.from(metadata.tags).sort((a, b) => a.localeCompare(b))
            : [],
          supportedEndpointTypes: metadata
            ? Array.from(metadata.supportedEndpointTypes).sort((a, b) =>
                a.localeCompare(b),
              )
            : [],
          capabilities: lookupModelsDevCapabilities(m.name),
          pricingSources: metadata?.pricingSources || [],
          accounts,
        };
      });

      models.sort((a, b) => b.accountCount - a.accountCount);
      writeModelsMarketplaceCache(includePricing, models);
      return {
        models,
        meta: {
          refreshRequested,
          refreshQueued,
          refreshReused,
          refreshRunning: !!runningRefreshTask,
          refreshJobId,
          includePricing,
          // Explicit on both paths so clients can rely on its presence:
          // true = served from cache, false = freshly computed.
          cacheHit: false,
        },
      };
    },
  );

  app.get(
    '/api/models/token-candidates',
    { preHandler: [limitModelTokenCandidatesRead] },
    async () => {
      const resolveTokenGroupLabel = (
        tokenGroup: string | null,
        tokenName: string | null,
      ): string | null => {
        const explicit = (tokenGroup || '').trim();
        if (explicit) return explicit;

        const name = (tokenName || '').trim();
        if (!name) return null;
        const normalized = name.toLowerCase();
        if (
          normalized === 'default' ||
          normalized === '默认' ||
          /^default($|[-_\s])/.test(normalized)
        ) {
          return 'default';
        }
        if (/^token-\d+$/.test(normalized)) return null;
        return name;
      };

      const rows = await db
        .select()
        .from(schema.tokenModelAvailability)
        .innerJoin(
          schema.accountTokens,
          eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id),
        )
        .innerJoin(
          schema.accounts,
          eq(schema.accountTokens.accountId, schema.accounts.id),
        )
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.tokenModelAvailability.available, true),
            eq(schema.accountTokens.enabled, true),
            eq(
              schema.accountTokens.valueStatus,
              ACCOUNT_TOKEN_VALUE_STATUS_READY,
            ),
            eq(schema.accounts.status, 'active'),
            eq(schema.sites.status, 'active'),
          ),
        )
        .all();
      const availableModelRows = await db
        .select({
          modelName: schema.modelAvailability.modelName,
          accountId: schema.accounts.id,
          username: schema.accounts.username,
          siteId: schema.sites.id,
          siteName: schema.sites.name,
          accessToken: schema.accounts.accessToken,
          apiToken: schema.accounts.apiToken,
          extraConfig: schema.accounts.extraConfig,
        })
        .from(schema.modelAvailability)
        .innerJoin(
          schema.accounts,
          eq(schema.modelAvailability.accountId, schema.accounts.id),
        )
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.modelAvailability.available, true),
            eq(schema.accounts.status, 'active'),
            eq(schema.sites.status, 'active'),
          ),
        )
        .all();

      const disabledModelsIndex = await loadSiteDisabledModelsIndex();

      const result: Record<
        string,
        Array<{
          accountId: number;
          tokenId: number;
          tokenName: string;
          isDefault: boolean;
          username: string | null;
          siteId: number;
          siteName: string;
        }>
      > = {};
      const coveredAccountModelSet = new Set<string>();
      const coveredGroupsByAccountModel = new Map<
        string,
        Map<string, string>
      >();
      const unknownGroupCoverageByAccountModel = new Set<string>();
      const modelsWithoutToken: Record<
        string,
        Array<{
          accountId: number;
          username: string | null;
          siteId: number;
          siteName: string;
        }>
      > = {};
      const modelsMissingTokenGroups: Record<
        string,
        Array<{
          accountId: number;
          username: string | null;
          siteId: number;
          siteName: string;
          missingGroups: string[];
          requiredGroups: string[];
          availableGroups: string[];
          groupCoverageUncertain?: boolean;
        }>
      > = {};
      let hasAnyTokenGroupSignals = false;

      for (const row of rows) {
        const modelName = (row.token_model_availability.modelName || '').trim();
        if (!modelName) continue;
        if (isModelDisabledForSite(disabledModelsIndex, row.sites.id, modelName, row.accounts.id)) continue;
        const accountModelKey = `${row.accounts.id}::${modelName.toLowerCase()}`;
        coveredAccountModelSet.add(accountModelKey);

        const resolvedTokenGroup = resolveTokenGroupLabel(
          row.account_tokens.tokenGroup,
          row.account_tokens.name,
        );
        if (resolvedTokenGroup) {
          hasAnyTokenGroupSignals = true;
          if (!coveredGroupsByAccountModel.has(accountModelKey)) {
            coveredGroupsByAccountModel.set(
              accountModelKey,
              new Map<string, string>(),
            );
          }
          const groupKey = resolvedTokenGroup.toLowerCase();
          if (
            !coveredGroupsByAccountModel.get(accountModelKey)!.has(groupKey)
          ) {
            coveredGroupsByAccountModel
              .get(accountModelKey)!
              .set(groupKey, resolvedTokenGroup);
          }
        } else {
          unknownGroupCoverageByAccountModel.add(accountModelKey);
        }

        if (!result[modelName]) result[modelName] = [];
        if (
          result[modelName].some(
            (item) => item.tokenId === row.account_tokens.id,
          )
        )
          continue;
        result[modelName].push({
          accountId: row.accounts.id,
          tokenId: row.account_tokens.id,
          tokenName: row.account_tokens.name,
          isDefault: !!row.account_tokens.isDefault,
          username: row.accounts.username,
          siteId: row.sites.id,
          siteName: row.sites.name,
        });
      }

      for (const row of availableModelRows) {
        if (!requiresManagedAccountTokens(row)) continue;
        const modelName = (row.modelName || '').trim();
        if (!modelName) continue;
        if (isModelDisabledForSite(disabledModelsIndex, row.siteId, modelName, row.accountId)) continue;
        const coverageKey = `${row.accountId}::${modelName.toLowerCase()}`;
        if (coveredAccountModelSet.has(coverageKey)) continue;
        if (!modelsWithoutToken[modelName]) modelsWithoutToken[modelName] = [];
        if (
          modelsWithoutToken[modelName].some(
            (item) => item.accountId === row.accountId,
          )
        )
          continue;
        modelsWithoutToken[modelName].push({
          accountId: row.accountId,
          username: row.username,
          siteId: row.siteId,
          siteName: row.siteName,
        });
      }

      const accountIdsForGroupHints = new Set(
        availableModelRows
          .filter((row: any) => requiresManagedAccountTokens(row))
          .map((row: any) => row.accountId),
      );
      const requiredGroupsByAccountModel = new Map<
        string,
        Map<string, string>
      >();
      const hasPotentialGroupHints =
        hasAnyTokenGroupSignals || unknownGroupCoverageByAccountModel.size > 0;

      if (hasPotentialGroupHints && accountIdsForGroupHints.size > 0) {
        const accountRows = await db
          .select()
          .from(schema.accounts)
          .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .where(
            and(
              eq(schema.accounts.status, 'active'),
              eq(schema.sites.status, 'active'),
            ),
          )
          .all();

        const metadataResults = await mapWithConcurrency(
          accountRows
            .filter((row: any) => accountIdsForGroupHints.has(row.accounts.id)),
          6,
          async (row: any) => {
            try {
              const catalog = await fetchModelPricingCatalog({
                site: {
                  id: row.sites.id,
                  url: row.sites.url,
                  platform: row.sites.platform,
                },
                account: {
                  id: row.accounts.id,
                  accessToken: row.accounts.accessToken,
                  apiToken: row.accounts.apiToken,
                },
                modelName: '__metadata__',
                totalTokens: 0,
              });
              return { accountId: row.accounts.id, catalog };
            } catch {
              return {
                accountId: row.accounts.id,
                catalog: null as Awaited<
                  ReturnType<typeof fetchModelPricingCatalog>
                >,
              };
            }
          },
        );

        for (const result of metadataResults) {
          if (!result.catalog) continue;
          for (const model of result.catalog.models) {
            const modelName = (model.modelName || '').trim();
            if (!modelName) continue;
            const groups = new Map<string, string>();
            for (const rawGroup of model.enableGroups || []) {
              const group = String(rawGroup || '').trim();
              if (!group) continue;
              const groupKey = group.toLowerCase();
              if (!groups.has(groupKey)) groups.set(groupKey, group);
            }
            if (groups.size === 0) continue;
            requiredGroupsByAccountModel.set(
              `${result.accountId}::${modelName.toLowerCase()}`,
              groups,
            );
          }
        }
      }

      for (const row of availableModelRows) {
        if (!requiresManagedAccountTokens(row)) continue;
        const modelName = (row.modelName || '').trim();
        if (!modelName) continue;
        const accountModelKey = `${row.accountId}::${modelName.toLowerCase()}`;

        const requiredGroups =
          requiredGroupsByAccountModel.get(accountModelKey);
        if (!requiredGroups || requiredGroups.size === 0) continue;

        const availableGroups =
          coveredGroupsByAccountModel.get(accountModelKey) ||
          new Map<string, string>();
        // The model is usable as long as the account has a token in any one
        // of the groups the model supports. Only report a missing-group hint
        // when the account has no covered group at all that can serve this
        // model — there is no need to create keys for every other group.
        const hasAnyUsableGroup = Array.from(requiredGroups.keys()).some(
          (groupKey) => availableGroups.has(groupKey),
        );
        if (hasAnyUsableGroup) continue;
        const missingGroups = Array.from(requiredGroups.entries())
          .filter(([groupKey]) => !availableGroups.has(groupKey))
          .map(([, label]) => label);
        if (missingGroups.length === 0) continue;

        if (!modelsMissingTokenGroups[modelName])
          modelsMissingTokenGroups[modelName] = [];
        if (
          modelsMissingTokenGroups[modelName].some(
            (item) => item.accountId === row.accountId,
          )
        )
          continue;
        const hintRow = {
          accountId: row.accountId,
          username: row.username,
          siteId: row.siteId,
          siteName: row.siteName,
          missingGroups: missingGroups.sort((a, b) => a.localeCompare(b)),
          requiredGroups: Array.from(requiredGroups.values()).sort((a, b) =>
            a.localeCompare(b),
          ),
          availableGroups: Array.from(availableGroups.values()).sort((a, b) =>
            a.localeCompare(b),
          ),
        } as {
          accountId: number;
          username: string | null;
          siteId: number;
          siteName: string;
          missingGroups: string[];
          requiredGroups: string[];
          availableGroups: string[];
          groupCoverageUncertain?: boolean;
        };
        if (unknownGroupCoverageByAccountModel.has(accountModelKey)) {
          hintRow.groupCoverageUncertain = true;
        }
        modelsMissingTokenGroups[modelName].push(hintRow);
      }

      const endpointTypesByModel: Record<string, string[]> = {};
      const cachedPricing = readModelsMarketplaceCache(true);
      const cachedBase = cachedPricing || readModelsMarketplaceCache(false);
      if (cachedBase) {
        for (const model of cachedBase) {
          if (
            Array.isArray(model.supportedEndpointTypes) &&
            model.supportedEndpointTypes.length > 0
          ) {
            endpointTypesByModel[model.name] = model.supportedEndpointTypes;
          }
        }
      }

      return {
        models: result,
        modelsWithoutToken,
        modelsMissingTokenGroups,
        endpointTypesByModel,
      };
    },
  );

  app.post<{ Params: { accountId: string } }>(
    '/api/models/check/:accountId',
    { preHandler: [limitModelCheck] },
    async (request, reply) => {
      const accountId = Number.parseInt(request.params.accountId, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ success: false, error: 'Invalid account id' });
      }
      const accountExists = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();
      if (!accountExists) {
        return reply.code(404).send({ success: false, error: 'Account not found' });
      }

      const refresh = await refreshModelsForAccount(accountId);
      const rebuild = await routeRefreshWorkflow.rebuildRoutesOnly();
      return { success: true, refresh, rebuild };
    },
  );

  app.post<{ Body?: { model?: string; modelName?: string; siteId?: number | string; accountId?: number | string } }>(
    '/api/models/probe-one',
    { preHandler: [limitModelProbe] },
    async (request, reply) => {
      const requestBody = request.body;
      if (requestBody !== undefined && !isRecord(requestBody)) {
        return reply
          .code(400)
          .send({ success: false, message: '请求体必须是对象' });
      }
      const modelName = String(
        requestBody?.modelName ?? requestBody?.model ?? '',
      ).trim();
      if (!modelName) {
        return reply
          .code(400)
          .send({ success: false, message: 'model 不能为空' });
      }

      const rawSiteId = requestBody?.siteId as unknown;
      const rawAccountId = requestBody?.accountId as unknown;
      const siteId = rawSiteId === undefined || rawSiteId === null || rawSiteId === ''
        ? null
        : Number(rawSiteId);
      const accountId = rawAccountId === undefined || rawAccountId === null || rawAccountId === ''
        ? null
        : Number(rawAccountId);
      if (siteId != null && (!Number.isFinite(siteId) || siteId <= 0)) {
        return reply.code(400).send({ success: false, message: 'siteId 无效' });
      }
      if (accountId != null && (!Number.isFinite(accountId) || accountId <= 0)) {
        return reply.code(400).send({ success: false, message: 'accountId 无效' });
      }

      const result = await probeSingleModelAvailability(modelName, {
        siteId,
        accountId,
      });
      // Probe mutates model_availability latency/available; drop marketplace cache.
      clearModelsMarketplaceCache();
      if (result.status === 'not_found') {
        return reply.code(404).send({
          success: false,
          ...result,
          message: result.reason,
        });
      }
      return {
        success: true,
        ...result,
      };
    },
  );

  app.post<{ Body?: { model?: string; modelName?: string; siteId?: number | string; accountId?: number | string } }>(
    '/api/models/probe-one/stream',
    { preHandler: [limitModelProbe] },
    async (request, reply) => {
      const requestBody = request.body;
      if (requestBody !== undefined && !isRecord(requestBody)) {
        return reply
          .code(400)
          .send({ success: false, message: '请求体必须是对象' });
      }
      const modelName = String(
        requestBody?.modelName ?? requestBody?.model ?? '',
      ).trim();
      if (!modelName) {
        return reply
          .code(400)
          .send({ success: false, message: 'model 不能为空' });
      }

      const rawSiteId = requestBody?.siteId as unknown;
      const rawAccountId = requestBody?.accountId as unknown;
      const siteId = rawSiteId === undefined || rawSiteId === null || rawSiteId === ''
        ? null
        : Number(rawSiteId);
      const accountId = rawAccountId === undefined || rawAccountId === null || rawAccountId === ''
        ? null
        : Number(rawAccountId);
      if (siteId != null && (!Number.isFinite(siteId) || siteId <= 0)) {
        return reply.code(400).send({ success: false, message: 'siteId 无效' });
      }
      if (accountId != null && (!Number.isFinite(accountId) || accountId <= 0)) {
        return reply.code(400).send({ success: false, message: 'accountId 无效' });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (event: string, data: unknown) => {
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          // client disconnected
        }
      };

      try {
        send('start', { modelName });
        const result = await probeSingleModelAvailabilityStream(
          modelName,
          { siteId, accountId },
          (row) => {
            send('result', row);
          },
        );
        clearModelsMarketplaceCache();
        send('done', { success: true, ...result });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        send('error', {
          success: false,
          message: errorMessage || '探测失败',
        });
      } finally {
        try { reply.raw.end(); } catch {}
      }
      return reply;
    },
  );
}
