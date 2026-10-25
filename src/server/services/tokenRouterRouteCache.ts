/**
 * Route-match cache subsystem.
 *
 * Fourth slice of the `tokenRouter.ts` split. The whole subsystem travels as one
 * unit: snapshot state, single-flight stores, TTL policy, the two async loaders
 * and every invalidator. All four maps/values are touched only inside this file,
 * so nothing needs to be plumbed back into the router — it imports the functions
 * it still calls.
 */
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import type { ChannelRow, RouteMatch, RouteRow } from './tokenRouterTypes.js';
import { invalidateModelsSurfaceCache } from './modelsSurfaceCache.js';
import {
  isExplicitGroupRoute,
  normalizeChannelSourceModel,
  normalizeRouteMode,
} from './tokenRouterModelMatching.js';
import { isExactRouteModelPattern } from './tokenRouterModelPatterns.js';
import {
  getStableFirstLastSelectedSiteByKey,
  getStableFirstObservationProgressByKey,
  getStableFirstObservationSiteCooldownByKey,
} from './tokenRouterStableFirstMemory.js';

type RouteCacheSnapshot = {
  loadedAt: number;
  routes: RouteRow[];
};

type RouteMatchCacheSnapshot = {
  loadedAt: number;
  match: RouteMatch;
};

let routeCacheSnapshot: RouteCacheSnapshot = {
  loadedAt: 0,
  routes: [],
};

const routeMatchCache = new Map<number, RouteMatchCacheSnapshot>();

// Single-flight promise stores: prevent concurrent cache-miss queries from
// all hitting the DB at once. When the first caller starts loading, subsequent
// callers await the same promise instead of issuing duplicate queries.
let enabledRoutesInflight: Promise<RouteRow[]> | null = null;
const routeMatchInflight = new Map<number, Promise<RouteMatch>>();

export function resolveTokenRouterCacheTtlMs(): number {
  const raw = Math.trunc(config.tokenRouterCacheTtlMs || 0);
  return Math.max(100, raw);
}

export function isCacheFresh(loadedAt: number, nowMs: number): boolean {
  return nowMs - loadedAt < resolveTokenRouterCacheTtlMs();
}

export async function loadEnabledRoutes(nowMs = Date.now()): Promise<RouteRow[]> {
  if (isCacheFresh(routeCacheSnapshot.loadedAt, nowMs)) {
    return routeCacheSnapshot.routes;
  }
  // Single-flight: if another caller is already loading, share its promise.
  if (enabledRoutesInflight) {
    return enabledRoutesInflight;
  }

  enabledRoutesInflight = (async () => {
    const rawRoutes = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.enabled, true))
      .all();
    const explicitGroupRouteIds = rawRoutes
      .filter((route: any) => normalizeRouteMode(route.routeMode) === 'explicit_group')
      .map((route: any) => route.id);
    const sourceRows = explicitGroupRouteIds.length > 0
      ? await db.select().from(schema.routeGroupSources)
        .where(inArray(schema.routeGroupSources.groupRouteId, explicitGroupRouteIds))
        .all()
      : [];
    const sourceIdsByRouteId = new Map<number, number[]>();
    for (const row of sourceRows) {
      if (!sourceIdsByRouteId.has(row.groupRouteId)) {
        sourceIdsByRouteId.set(row.groupRouteId, []);
      }
      sourceIdsByRouteId.get(row.groupRouteId)!.push(row.sourceRouteId);
    }
    const routes = rawRoutes.map((route: any) => ({
      ...route,
      routeMode: normalizeRouteMode(route.routeMode),
      sourceRouteIds: Array.from(new Set(sourceIdsByRouteId.get(route.id) ?? [])),
    }));
    routeCacheSnapshot = {
      loadedAt: Date.now(),
      routes,
    };
    return routes;
  })();

  try {
    return await enabledRoutesInflight;
  } finally {
    enabledRoutesInflight = null;
  }
}

export async function loadRouteMatch(route: RouteRow, nowMs = Date.now()): Promise<RouteMatch> {
  const cached = routeMatchCache.get(route.id);
  if (cached && isCacheFresh(cached.loadedAt, nowMs)) {
    return cached.match;
  }
  // Single-flight: if another caller is already loading this route match,
  // share its promise.
  const existing = routeMatchInflight.get(route.id);
  if (existing) {
    return existing;
  }

  const promise = (async (): Promise<RouteMatch> => {
    const enabledRoutes = await loadEnabledRoutes(nowMs);
    const routeIds = (() => {
      if (!isExplicitGroupRoute(route)) {
        return [route.id];
      }
      return Array.from(new Set(route.sourceRouteIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0)));
    })();
    const enabledSourceRoutes = isExplicitGroupRoute(route)
      ? enabledRoutes.filter((item) => (
        routeIds.includes(item.id)
        && !isExplicitGroupRoute(item)
        && isExactRouteModelPattern(item.modelPattern)
      ))
      : enabledRoutes.filter((item) => routeIds.includes(item.id));
    const enabledSourceRouteIds = enabledSourceRoutes.map((item) => item.id);
    const fallbackSourceModelByRouteId = new Map<number, string>(
      enabledSourceRoutes
        .filter((item) => isExactRouteModelPattern(item.modelPattern))
        .map((item) => [item.id, (item.modelPattern || '').trim()]),
    );
    const channels = enabledSourceRouteIds.length > 0
      ? await db
        .select()
        .from(schema.routeChannels)
        .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
        .where(inArray(schema.routeChannels.routeId, enabledSourceRouteIds))
        .all()
      : [];

    const mapped = channels.map((row: any) => ({
      channel: {
        ...row.route_channels,
        sourceModel: normalizeChannelSourceModel(row.route_channels.sourceModel)
          || fallbackSourceModelByRouteId.get(row.route_channels.routeId)
          || null,
      },
      account: row.accounts,
      site: row.sites,
      token: row.account_tokens,
    }));

    const match = { route, channels: mapped };
    routeMatchCache.set(route.id, {
      loadedAt: Date.now(),
      match,
    });
    return match;
  })();

  routeMatchInflight.set(route.id, promise);

  try {
    return await promise;
  } finally {
    routeMatchInflight.delete(route.id);
  }
}

export function patchCachedChannel(channelId: number, apply: (channel: ChannelRow) => void): void {
  for (const entry of routeMatchCache.values()) {
    const target = entry.match.channels.find((item) => item.channel.id === channelId);
    if (!target) continue;
    apply(target.channel);
    break;
  }
}

export function clearStableFirstCachesForRoute(routeId: number): void {
  const routePrefix = `${routeId}:`;
  for (const key of getStableFirstLastSelectedSiteByKey().keys()) {
    if (key.startsWith(routePrefix)) {
      getStableFirstLastSelectedSiteByKey().delete(key);
    }
  }
  for (const key of getStableFirstObservationProgressByKey().keys()) {
    if (key.startsWith(routePrefix)) {
      getStableFirstObservationProgressByKey().delete(key);
    }
  }
  for (const key of getStableFirstObservationSiteCooldownByKey().keys()) {
    if (key.startsWith(routePrefix)) {
      getStableFirstObservationSiteCooldownByKey().delete(key);
    }
  }
}

export function invalidateRouteScopedCache(routeId: number): void {
  if (!Number.isFinite(routeId) || routeId <= 0) return;
  routeMatchCache.delete(routeId);
  clearStableFirstCachesForRoute(routeId);
}

export function invalidateTokenRouterCache(): void {
  routeCacheSnapshot = {
    loadedAt: 0,
    routes: [],
  };
  // /v1/models listings are derived from route availability: any invalidation
  // that can add/remove models or flip channel availability must also drop the
  // response cache.
  invalidateModelsSurfaceCache();
  routeMatchCache.clear();
  getStableFirstLastSelectedSiteByKey().clear();
  getStableFirstObservationProgressByKey().clear();
  getStableFirstObservationSiteCooldownByKey().clear();
}
