import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  config,
  normalizeTokenRouterFailureCooldownMaxSec,
  TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING,
} from '../config.js';
import {refreshModelPricingCatalog} from './modelPricingService.js';
import { proxyChannelCoordinator, type ProxyChannelLoadSnapshot } from './proxyChannelCoordinator.js';
import {classifyProxyFailure, isUsageLimitRateLimitFailure, type SiteRuntimeFailureContext} from './siteFailureClassification.js';
import {SITE_API_ENDPOINT_COOLDOWN_MS} from './siteApiEndpointService.js';
import {clampFailureCooldownMs as clampFailureCooldownMsMath, clampNumber, isContributionCloseToBest, resolveEffectiveFailureCooldownMs as resolveEffectiveFailureCooldownMsMath, resolveFailureBackoffSec, resolveRoundRobinCooldownSec, ROUND_ROBIN_COOLDOWN_LEVELS_SEC} from './tokenRouterMath.js';
import {
  getStableFirstLastSelectedSiteByKey,
  getStableFirstObservationProgressByKey,
  getStableFirstObservationSiteCooldownByKey,
  rememberStableFirstObservationProgressForKey,
  rememberStableFirstObservationSiteCooldown,
  rememberStableFirstSiteSelectionForKey,
} from './tokenRouterStableFirstMemory.js';
import {clearRuntimeHealthStatesForChannels, persistSiteRuntimeHealthState, ensureSiteRuntimeHealthStateLoaded, filterSiteRuntimeBrokenCandidatesByModel, getSiteRuntimeHealthDetails, recordSiteRuntimeFailure, recordSiteRuntimeSuccess, type SiteRuntimeHealthDetails} from './tokenRouterRuntimeHealthStore.js';
import {
  filterRecentlyFailedCandidates as filterRecentlyFailedCandidatesPure,
  isChannelRecentlyFailed as isChannelRecentlyFailedPure,
  type FailureAwareChannel,
} from './tokenRouterCandidateFilter.js';
import {
  buildContributionRanks,
  countCandidatesBySite,
  normalizeContributions,
  normalizeValueScores,
  rankContributionIndices,
  selectWeightedIndex,
} from './tokenRouterProbability.js';
import { selectWithBoundedGap, type BoundedGapState } from './boundedGapSelection.js';
import {
  attachBoundedGapStateMap,
  ensureBoundedGapStatesLoaded,
  markBoundedGapStateDirty,
} from './boundedGapPersistence.js';
import {
  normalizeRouteRoutingStrategy,
  type RouteRoutingStrategy,
} from './routeRoutingStrategy.js';
import { resolveDownstreamPolicyModel } from './downstreamPolicyTypes.js';
import { type DownstreamRoutingPolicy, EMPTY_DOWNSTREAM_ROUTING_POLICY } from './downstreamPolicyTypes.js';
import { isUsableAccountToken } from './accountTokenService.js';
import { getCredentialModeFromExtraConfig } from './accountExtraConfig.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { parseCodexQuotaResetHint } from './oauth/quota.js';
import {
  getOauthRouteUnitStrategyLabel,
  listOauthRouteUnitMembersByUnitIds,
  loadOauthRouteUnitSummariesByIds,
  type OAuthRouteUnitSummary,
} from './oauth/routeUnitService.js';
import {buildVisibleEnabledRoutes, channelSupportsRequestedModel, getExposedModelNameForRoute, isExplicitGroupRoute, isModelAllowedByDownstreamPolicy, isRouteDisplayNameMatch, normalizeChannelSourceModel, normalizeModelAlias, normalizeRouteDisplayName, normalizeRouteMode, resolveMappedModel, resolveModelResolution, type ModelResolution} from './tokenRouterModelMatching.js';
import {isExactRouteModelPattern, matchesModelPattern} from './tokenRouterModelPatterns.js';
import {formatShadowSelectionLog, rankShadowCandidates, type ShadowCandidateInput} from './routeScoringShadow.js';
import {
  loadConnectivityLookup,
  resolveCandidateConnectivity,
  softAvoidDisconnectedCandidates,
  type ConnectivityLookup,
  type ConnectivitySignal,
} from './routeConnectivityLookup.js';
import { siteProtocolAffinityFactor } from '../shared/siteProtocolProfile.js';
import {
  type RouteDecision,
  type RouteDecisionCandidate,
  type RouteDecisionReasonCode,
  type RouteMode,
} from '../../shared/tokenRouteContract.js';

interface RouteMatch {
  route: RouteRow;
  channels: Array<{
    channel: typeof schema.routeChannels.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    site: typeof schema.sites.$inferSelect;
    token: typeof schema.accountTokens.$inferSelect | null;
    routeUnit: OAuthRouteUnitSummary | null;
    routeUnitMembers: Array<{
      member: typeof schema.oauthRouteUnitMembers.$inferSelect;
      account: typeof schema.accounts.$inferSelect;
      site: typeof schema.sites.$inferSelect;
      token: null;
    }>;
  }>;
}

type RouteChannelCandidate = RouteMatch['channels'][number];

interface SelectedChannel {
  channel: typeof schema.routeChannels.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  token: typeof schema.accountTokens.$inferSelect | null;
  tokenValue: string;
  tokenName: string;
  actualModel: string;
}

const SHORT_WINDOW_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const ROUND_ROBIN_FAILURE_THRESHOLD = 3;
const SITE_RECENT_SUCCESS_FALLBACK_RATE = 0.5;
const SITE_HISTORICAL_HEALTH_MIN_MULTIPLIER = 0.45;
const SITE_HISTORICAL_HEALTH_MAX_SAMPLE = 24;
const SITE_HISTORICAL_LATENCY_BASELINE_MS = 3_000;
const SITE_HISTORICAL_LATENCY_WINDOW_MS = 25_000;
const SITE_HISTORICAL_MAX_LATENCY_PENALTY = 0.45;


type WeightedSelectionMode = 'weighted' | 'stable_first';
type WeightedSelectionResult = {
  selected: RouteChannelCandidate | null;
  details: Array<{ candidate: RouteChannelCandidate; probability: number; reason: string }>;
  stableSiteCount: number;
};


type StableFirstSitePoolState = {
  siteId: number;
  leader: RouteChannelCandidate;
  effectiveSuccessRate: number;
  trusted: boolean;
  observationReason: string | null;
};

type StableFirstPoolPlan = {
  primaryCandidates: RouteChannelCandidate[];
  observationCandidates: RouteChannelCandidate[];
  primarySiteIds: Set<number>;
  observationSiteIds: Set<number>;
  siteStateById: Map<number, StableFirstSitePoolState>;
};

const STABLE_FIRST_PRIMARY_SUCCESS_RATE_RATIO = 0.92;
const STABLE_FIRST_TRUSTED_RECENT_CONFIDENCE = 0.5;
const STABLE_FIRST_TRUSTED_HISTORICAL_CALLS = 8;
const STABLE_FIRST_OBSERVATION_REQUEST_INTERVAL = 24;
const STABLE_FIRST_OBSERVATION_SITE_COOLDOWN_MS = 30 * 60 * 1000;

const boundedGapStates = new Map<string, BoundedGapState>();
attachBoundedGapStateMap(boundedGapStates);

function getBoundedGapState(requestedModel: string, siteId: number): BoundedGapState {
  const key = `${requestedModel}\u0000${siteId}`;
  const existing = boundedGapStates.get(key);
  if (existing) return existing;
  const state = { sequence: 0, lastSelectedSequence: null };
  boundedGapStates.set(key, state);
  return state;
}

function resolveConfiguredFailureCooldownMaxMs(): number {
  const normalized = normalizeTokenRouterFailureCooldownMaxSec(config.tokenRouterFailureCooldownMaxSec)
    ?? TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING;
  return Math.max(1_000, normalized * 1000);
}

function clampFailureCooldownMs(cooldownMs: number): number {
  return clampFailureCooldownMsMath(cooldownMs, resolveConfiguredFailureCooldownMaxMs());
}

function resolveEffectiveFailureCooldownMs(failCount?: number | null, weight = 1): number {
  const maxMs = resolveConfiguredFailureCooldownMaxMs();
  const rawBackoffMs = resolveEffectiveFailureCooldownMsMath(failCount, maxMs);
  const normalizedWeight = Number.isFinite(weight)
    ? Math.max(0.1, Math.min(3, Number(weight)))
    : 1;
  // Apply weight BEFORE clamping so the ceiling cannot be exceeded by weight
  return clampFailureCooldownMsMath(rawBackoffMs * normalizedWeight, maxMs);
}

function resolveFailureCooldownWeight(context: SiteRuntimeFailureContext = {}): {
  weight: number;
  skipCooldown: boolean;
} {
  const decision = classifyProxyFailure(context);
  return {
    weight: decision.cooldownWeight,
    // Client/policy rejections should not park the channel out of the pool.
    skipCooldown: decision.cooldownScope === 'none',
  };
}

function resolveStableFirstSuccessRate(
  details: SiteRuntimeHealthDetails,
  historicalSuccessRate: number | null | undefined,
): number {
  const fallbackRate = historicalSuccessRate ?? SITE_RECENT_SUCCESS_FALLBACK_RATE;
  return (
    (details.recentSuccessRate * details.recentConfidence)
    + (fallbackRate * (1 - details.recentConfidence))
  );
}

function resolveShortWindowLimitCooldown(
  account: typeof schema.accounts.$inferSelect,
  context: SiteRuntimeFailureContext = {},
  nowMs = Date.now(),
): string | null {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  if (!isUsageLimitRateLimitFailure({ status, errorText })) return null;

  const resetHint = parseCodexQuotaResetHint(status, errorText, nowMs);
  if (resetHint) {
    const hintMs = Date.parse(resetHint.resetAt);
    if (Number.isFinite(hintMs) && hintMs > nowMs) {
      return new Date(hintMs).toISOString();
    }
  }

  const oauth = getOauthInfoFromAccount(account);
  const storedResetAt = oauth?.quota?.lastLimitResetAt;
  if (oauth?.provider === 'codex' && storedResetAt) {
    const storedMs = Date.parse(storedResetAt);
    if (Number.isFinite(storedMs) && storedMs > nowMs) {
      return new Date(storedMs).toISOString();
    }
  }

  return new Date(nowMs + SHORT_WINDOW_LIMIT_COOLDOWN_MS).toISOString();
}

async function loadCredentialScopedChannelIds(
  channel: typeof schema.routeChannels.$inferSelect,
  accountId: number,
): Promise<number[]> {
  if (typeof channel.tokenId === 'number' && channel.tokenId > 0) {
    const rows = await db.select({ id: schema.routeChannels.id })
      .from(schema.routeChannels)
      .where(eq(schema.routeChannels.tokenId, channel.tokenId))
      .all();
    return rows.map((row: any) => row.id);
  }

  const rows = await db.select({ id: schema.routeChannels.id })
    .from(schema.routeChannels)
    .where(and(
      eq(schema.routeChannels.accountId, accountId),
      isNull(schema.routeChannels.tokenId),
    ))
    .all();
  return rows.map((row: any) => row.id);
}

type RouteRow = typeof schema.tokenRoutes.$inferSelect & {
  routeMode: RouteMode;
  sourceRouteIds: number[];
};
type ChannelRow = typeof schema.routeChannels.$inferSelect;

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

function resolveTokenRouterCacheTtlMs(): number {
  const raw = Math.trunc(config.tokenRouterCacheTtlMs || 0);
  return Math.max(100, raw);
}

function isCacheFresh(loadedAt: number, nowMs: number): boolean {
  return nowMs - loadedAt < resolveTokenRouterCacheTtlMs();
}

async function loadEnabledRoutes(nowMs = Date.now()): Promise<RouteRow[]> {
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

async function loadRouteMatch(route: RouteRow, nowMs = Date.now()): Promise<RouteMatch> {
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

    const oauthRouteUnitIds: number[] = Array.from(new Set<number>(
      channels
        .map((row: any) => Number(row.route_channels.oauthRouteUnitId))
        .filter((id: any): id is number => Number.isFinite(id) && id > 0),
    ));
    const [routeUnitSummaries, routeUnitMembersByUnitId] = await Promise.all([
      loadOauthRouteUnitSummariesByIds(oauthRouteUnitIds),
      listOauthRouteUnitMembersByUnitIds(oauthRouteUnitIds),
    ]);

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
      routeUnit: row.route_channels.oauthRouteUnitId
        ? (routeUnitSummaries.get(row.route_channels.oauthRouteUnitId) || null)
        : null,
      routeUnitMembers: row.route_channels.oauthRouteUnitId
        ? (routeUnitMembersByUnitId.get(row.route_channels.oauthRouteUnitId) || []).map((member) => ({
          member: member.member,
          account: member.account,
          site: member.site,
          token: null,
        }))
        : [],
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

function patchCachedChannel(channelId: number, apply: (channel: ChannelRow) => void): void {
  for (const entry of routeMatchCache.values()) {
    const target = entry.match.channels.find((item) => item.channel.id === channelId);
    if (!target) continue;
    apply(target.channel);
    break;
  }
}

function clearStableFirstCachesForRoute(routeId: number): void {
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

function invalidateRouteScopedCache(routeId: number): void {
  if (!Number.isFinite(routeId) || routeId <= 0) return;
  routeMatchCache.delete(routeId);
  clearStableFirstCachesForRoute(routeId);
}

export function invalidateTokenRouterCache(): void {
  routeCacheSnapshot = {
    loadedAt: 0,
    routes: [],
  };
  routeMatchCache.clear();
  getStableFirstLastSelectedSiteByKey().clear();
  getStableFirstObservationProgressByKey().clear();
  getStableFirstObservationSiteCooldownByKey().clear();
}

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

export function isChannelRecentlyFailed(
  channel: FailureAwareChannel,
  nowMs = Date.now(),
  avoidSec = resolveFailureBackoffSec(channel.failCount),
): boolean {
  return isChannelRecentlyFailedPure(
    channel,
    nowMs,
    resolveConfiguredFailureCooldownMaxMs(),
    avoidSec,
  );
}

export function filterRecentlyFailedCandidates<T extends { channel: FailureAwareChannel }>(
  candidates: T[],
  nowMs = Date.now(),
  avoidSec?: number,
): T[] {
  return filterRecentlyFailedCandidatesPure(
    candidates,
    nowMs,
    resolveConfiguredFailureCooldownMaxMs(),
    avoidSec,
  );
}

export type RouteDecisionExplanation = RouteDecision & {
  routeId?: number;
  modelPattern?: string;
  selectedAccountId?: number;
  modelResolution?: ModelResolution;
};

const DEFAULT_DOWNSTREAM_POLICY: DownstreamRoutingPolicy = EMPTY_DOWNSTREAM_ROUTING_POLICY;

type ExplainSelectionOptions = {
  excludeChannelIds?: number[];
  bypassSourceModelCheck?: boolean;
  useChannelSourceModelForCost?: boolean;
  downstreamPolicy?: DownstreamRoutingPolicy;
};

type PricingReferenceRefreshOptions = {
  useChannelSourceModelForCost?: boolean;
  downstreamPolicy?: DownstreamRoutingPolicy;
  refreshedKeys?: Set<string>;
};

type CandidateEligibilityReason = {
  code: RouteDecisionReasonCode;
  message: string;
  details?: Record<string, unknown>;
};

function setCandidateDecisionReason(
  candidate: RouteDecisionCandidate,
  code: RouteDecisionReasonCode,
  reason: string,
  details?: Record<string, unknown>,
): void {
  candidate.reason = reason;
  candidate.reasonCodes = [code];
  candidate.reasonDetails = details;
}

type CandidateEligibilityOptions = {
  requestedModel: string;
  bypassSourceModelCheck?: boolean;
  excludeChannelIds?: number[];
  nowIso?: string;
  downstreamPolicy?: DownstreamRoutingPolicy;
};


function resolveRouteStrategy(route: RouteRow): RouteRoutingStrategy {
  return normalizeRouteRoutingStrategy(route.routingStrategy);
}

function parseIsoTimeMs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareNullableTimeAsc(left?: string | null, right?: string | null): number {
  const leftMs = parseIsoTimeMs(left);
  const rightMs = parseIsoTimeMs(right);
  if (leftMs == null && rightMs == null) return 0;
  if (leftMs == null) return -1;
  if (rightMs == null) return 1;
  return leftMs - rightMs;
}

function compareNullableTimeDesc(left?: string | null, right?: string | null): number {
  return compareNullableTimeAsc(right, left);
}

function isOauthRouteUnitCandidate(candidate: RouteChannelCandidate): boolean {
  return !!candidate.routeUnit || !!candidate.channel.oauthRouteUnitId;
}

function isOauthRouteUnitMemberCoolingDown(
  member: typeof schema.oauthRouteUnitMembers.$inferSelect,
  nowIso: string,
): boolean {
  return !!member.cooldownUntil && member.cooldownUntil > nowIso;
}

function compareStableFirstCandidateOrder(left: RouteChannelCandidate, right: RouteChannelCandidate): number {
  const selectionOrder = compareNullableTimeAsc(
    left.channel.lastSelectedAt || left.channel.lastUsedAt,
    right.channel.lastSelectedAt || right.channel.lastUsedAt,
  );
  if (selectionOrder !== 0) return selectionOrder;

  const usedOrder = compareNullableTimeAsc(left.channel.lastUsedAt, right.channel.lastUsedAt);
  if (usedOrder !== 0) return usedOrder;

  return (left.channel.id ?? 0) - (right.channel.id ?? 0);
}

function resolveChannelRuntimeLoadMultiplier(snapshot: ProxyChannelLoadSnapshot): number {
  if (!snapshot.sessionScoped || snapshot.concurrencyLimit <= 0) return 1;

  const activeRatio = clampNumber(snapshot.activeLeaseCount / Math.max(1, snapshot.concurrencyLimit), 0, 1.5);
  const waitingRatio = clampNumber(snapshot.waitingCount / Math.max(1, snapshot.concurrencyLimit), 0, 3);
  const activePenalty = activeRatio * 0.28;
  const waitingPenalty = waitingRatio * 0.32;
  const saturationPenalty = snapshot.saturated ? 0.12 : 0;
  return clampNumber(1 - activePenalty - waitingPenalty - saturationPenalty, 0.18, 1);
}

function formatChannelRuntimeLoad(snapshot: ProxyChannelLoadSnapshot): string {
  if (!snapshot.sessionScoped || snapshot.concurrencyLimit <= 0) {
    return '未限流';
  }
  const multiplier = resolveChannelRuntimeLoadMultiplier(snapshot);
  return `${multiplier.toFixed(2)}（活跃=${snapshot.activeLeaseCount}/${snapshot.concurrencyLimit}，等待=${snapshot.waitingCount}）`;
}

import {
  STICKY_PREFERRED_YIELD_LOW_COVERAGE,
  resolvePreferredBalanceCoverage,
  resolveEffectiveUnitCost,
  type PreferredChannelSelectionOptions,
} from './routeStickyPreferencePolicy.js';

type SiteHistoricalHealthMetrics = {
  multiplier: number;
  totalCalls: number;
  successRate: number | null;
  avgLatencyMs: number | null;
};

function buildSiteHistoricalHealthMetrics(candidates: RouteChannelCandidate[]): Map<number, SiteHistoricalHealthMetrics> {
  const totals = new Map<number, {
    totalCalls: number;
    successCount: number;
    failCount: number;
    totalLatencyMs: number;
    latencySamples: number;
  }>();

  for (const candidate of candidates) {
    const siteId = candidate.site.id;
    if (!totals.has(siteId)) {
      totals.set(siteId, {
        totalCalls: 0,
        successCount: 0,
        failCount: 0,
        totalLatencyMs: 0,
        latencySamples: 0,
      });
    }
    const target = totals.get(siteId)!;
    const successCount = Math.max(0, candidate.channel.successCount ?? 0);
    const failCount = Math.max(0, candidate.channel.failCount ?? 0);
    target.successCount += successCount;
    target.failCount += failCount;
    target.totalCalls += successCount + failCount;
    if (successCount > 0) {
      target.totalLatencyMs += Math.max(0, candidate.channel.totalLatencyMs ?? 0);
      target.latencySamples += successCount;
    }
  }

  const metrics = new Map<number, SiteHistoricalHealthMetrics>();
  for (const [siteId, total] of totals.entries()) {
    if (total.totalCalls <= 0) {
      metrics.set(siteId, {
        multiplier: 1,
        totalCalls: 0,
        successRate: null,
        avgLatencyMs: null,
      });
      continue;
    }

    const sampleFactor = clampNumber(total.totalCalls / SITE_HISTORICAL_HEALTH_MAX_SAMPLE, 0, 1);
    const successRate = total.successCount / total.totalCalls;
    const successPenaltyFactor = 1 - ((1 - successRate) * 0.55 * sampleFactor);
    const avgLatencyMs = total.latencySamples > 0
      ? Math.round(total.totalLatencyMs / total.latencySamples)
      : null;
    const latencyPenaltyRatio = avgLatencyMs == null
      ? 0
      : clampNumber(
        (avgLatencyMs - SITE_HISTORICAL_LATENCY_BASELINE_MS) / SITE_HISTORICAL_LATENCY_WINDOW_MS,
        0,
        1,
      ) * sampleFactor;
    const latencyFactor = 1 - (latencyPenaltyRatio * SITE_HISTORICAL_MAX_LATENCY_PENALTY);
    metrics.set(siteId, {
      multiplier: clampNumber(
        successPenaltyFactor * latencyFactor,
        SITE_HISTORICAL_HEALTH_MIN_MULTIPLIER,
        1,
      ),
      totalCalls: total.totalCalls,
      successRate,
      avgLatencyMs,
    });
  }

  return metrics;
}

function buildStableFirstPoolPlan(
  candidates: RouteChannelCandidate[],
  modelName: string | ((candidate: RouteChannelCandidate) => string),
  nowMs = Date.now(),
): StableFirstPoolPlan {
  if (candidates.length <= 0) {
    return {
      primaryCandidates: [],
      observationCandidates: [],
      primarySiteIds: new Set<number>(),
      observationSiteIds: new Set<number>(),
      siteStateById: new Map<number, StableFirstSitePoolState>(),
    };
  }

  const resolveModelName = typeof modelName === 'function'
    ? modelName
    : (() => modelName);
  const historicalBySiteId = buildSiteHistoricalHealthMetrics(candidates);
  const leaderBySiteId = new Map<number, RouteChannelCandidate>();
  const siteStateById = new Map<number, StableFirstSitePoolState>();

  for (const candidate of candidates) {
    const siteId = candidate.site.id;
    const currentLeader = leaderBySiteId.get(siteId);
    if (!currentLeader || compareStableFirstCandidateOrder(candidate, currentLeader) < 0) {
      leaderBySiteId.set(siteId, candidate);
    }
  }

  for (const [siteId, leader] of leaderBySiteId.entries()) {
    const healthDetails = getSiteRuntimeHealthDetails(siteId, resolveModelName(leader), nowMs);
    const historical = historicalBySiteId.get(siteId);
    const historicalTotalCalls = historical?.totalCalls ?? 0;
    const effectiveSuccessRate = resolveStableFirstSuccessRate(healthDetails, historical?.successRate);
    const trusted = (
      healthDetails.recentConfidence >= STABLE_FIRST_TRUSTED_RECENT_CONFIDENCE
      || historicalTotalCalls >= STABLE_FIRST_TRUSTED_HISTORICAL_CALLS
    );
    siteStateById.set(siteId, {
      siteId,
      leader,
      effectiveSuccessRate,
      trusted,
      observationReason: null,
    });
  }

  const allSiteStates = Array.from(siteStateById.values()).sort((left, right) => {
    const rateDiff = right.effectiveSuccessRate - left.effectiveSuccessRate;
    if (Math.abs(rateDiff) > 1e-9) return rateDiff > 0 ? 1 : -1;
    return compareStableFirstCandidateOrder(left.leader, right.leader);
  });
  const trustedSiteStates = allSiteStates.filter((state) => state.trusted);
  const leaderPool = trustedSiteStates.length > 0 ? trustedSiteStates : allSiteStates;

  const primarySiteIds = new Set<number>();
  const observationSiteIds = new Set<number>();
  const bestRate = leaderPool[0]?.effectiveSuccessRate ?? 0;
  const thresholdRate = bestRate > 0
    ? (bestRate * STABLE_FIRST_PRIMARY_SUCCESS_RATE_RATIO)
    : 0;

  for (const state of allSiteStates) {
    const inPrimary = leaderPool.length === 0
      ? true
      : (
        leaderPool.some((leaderState) => leaderState.siteId === state.siteId)
        && state.effectiveSuccessRate >= thresholdRate
      );
    if (inPrimary) {
      primarySiteIds.add(state.siteId);
      continue;
    }
    observationSiteIds.add(state.siteId);
    state.observationReason = state.trusted
      ? '观察池：近期成功率暂时落后，仅灰度真实流量会命中'
      : '观察池：近期样本不足，仅灰度真实流量会命中';
  }

  if (primarySiteIds.size <= 0 && allSiteStates.length > 0) {
    primarySiteIds.add(allSiteStates[0].siteId);
    observationSiteIds.delete(allSiteStates[0].siteId);
  }

  return {
    primaryCandidates: candidates.filter((candidate) => primarySiteIds.has(candidate.site.id)),
    observationCandidates: candidates.filter((candidate) => observationSiteIds.has(candidate.site.id)),
    primarySiteIds,
    observationSiteIds,
    siteStateById,
  };
}

function shouldUseStableFirstObservationCandidate(
  rotationKey: string,
  observationCandidates: RouteChannelCandidate[],
  nowMs = Date.now(),
): boolean {
  if (!rotationKey || observationCandidates.length <= 0) return false;
  const state = getStableFirstObservationProgressByKey().get(rotationKey) ?? {
    requestCount: 0,
    lastObservationAtMs: null,
  };
  if ((state.requestCount + 1) < STABLE_FIRST_OBSERVATION_REQUEST_INTERVAL) {
    return false;
  }
  return observationCandidates.some((candidate) => {
    const observedAtMs = getStableFirstObservationSiteCooldownByKey().get(`${rotationKey}:${candidate.site.id}`) ?? null;
    return observedAtMs == null || (nowMs - observedAtMs) >= STABLE_FIRST_OBSERVATION_SITE_COOLDOWN_MS;
  });
}

function updateStableFirstObservationProgress(
  rotationKey: string,
  input: {
    usedObservation: boolean;
    selectedSiteId?: number | null;
    nowMs?: number;
  },
): void {
  if (!rotationKey) return;
  const nowMs = input.nowMs ?? Date.now();
  const previous = getStableFirstObservationProgressByKey().get(rotationKey) ?? {
    requestCount: 0,
    lastObservationAtMs: null,
  };
  if (input.usedObservation) {
    rememberStableFirstObservationProgressForKey(rotationKey, {
      requestCount: 0,
      lastObservationAtMs: nowMs,
    });
    if (typeof input.selectedSiteId === 'number' && input.selectedSiteId > 0) {
      rememberStableFirstObservationSiteCooldown(rotationKey, input.selectedSiteId, nowMs);
    }
    return;
  }
  rememberStableFirstObservationProgressForKey(rotationKey, {
    requestCount: Math.max(0, previous.requestCount) + 1,
    lastObservationAtMs: previous.lastObservationAtMs,
  });
}

function isExplicitTokenChannel(candidate: RouteChannelCandidate): boolean {
  return typeof candidate.channel.tokenId === 'number' && candidate.channel.tokenId > 0;
}

export {
  isExactRouteModelPattern,
  isRegexModelPattern,
  matchesModelPattern,
  parseRegexModelPattern,
} from './tokenRouterModelPatterns.js';

export {
  filterSiteRuntimeBrokenCandidates,
  flushSiteRuntimeHealthPersistence,
  getSiteRuntimeHealthMultiplier,
  isSiteRuntimeBreakerOpen,
  resetSiteRuntimeHealthState,
} from './tokenRouterRuntimeHealthStore.js';

export class TokenRouter {
  /**
   * Find matching route and select a channel for the given model.
   * Returns null if no route/channel available.
   */
  async selectChannel(requestedModel: string, downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY): Promise<SelectedChannel | null> {
    const effectiveModel = resolveDownstreamPolicyModel(requestedModel, downstreamPolicy);
    if (!isModelAllowedByDownstreamPolicy(effectiveModel, downstreamPolicy)) return null;
    await ensureSiteRuntimeHealthStateLoaded();
    await ensureBoundedGapStatesLoaded();

    const match = await this.findRoute(effectiveModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, effectiveModel, downstreamPolicy);
  }

  async previewSelectedChannel(
    requestedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<SelectedChannel | null> {
    const effectiveModel = resolveDownstreamPolicyModel(requestedModel, downstreamPolicy);
    if (!isModelAllowedByDownstreamPolicy(effectiveModel, downstreamPolicy)) return null;
    await ensureSiteRuntimeHealthStateLoaded();
    await ensureBoundedGapStatesLoaded();

    const match = await this.findRoute(effectiveModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, effectiveModel, downstreamPolicy, [], false);
  }

  /**
   * Select next channel for failover (exclude already-tried channels).
   */
  /**
   * Count currently eligible channels for a model (no side effects).
   * Used by proxy surfaces to scale failover attempt/budget to pool size.
   */
  async countEligibleChannels(
    requestedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
    excludeChannelIds: number[] = [],
  ): Promise<number> {
    const effectiveModel = resolveDownstreamPolicyModel(requestedModel, downstreamPolicy);
    if (!isModelAllowedByDownstreamPolicy(effectiveModel, downstreamPolicy)) return 0;
    await ensureSiteRuntimeHealthStateLoaded();
    const match = await this.findRoute(effectiveModel, downstreamPolicy);
    if (!match) return 0;
    const nowIso = new Date().toISOString();
    const requestedByDisplayName = isRouteDisplayNameMatch(effectiveModel, match.route.displayName);
    return match.channels.filter((candidate) => (
      this.getCandidateEligibilityReasons(candidate, {
        requestedModel: effectiveModel,
        bypassSourceModelCheck: requestedByDisplayName,
        excludeChannelIds,
        nowIso,
        downstreamPolicy,
      }).length === 0
    )).length;
  }

  async selectNextChannel(
    requestedModel: string,
    excludeChannelIds: number[],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<SelectedChannel | null> {
    const effectiveModel = resolveDownstreamPolicyModel(requestedModel, downstreamPolicy);
    if (!isModelAllowedByDownstreamPolicy(effectiveModel, downstreamPolicy)) return null;
    await ensureSiteRuntimeHealthStateLoaded();

    const match = await this.findRoute(effectiveModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, effectiveModel, downstreamPolicy, excludeChannelIds);
  }

  /**
   * Expand a failed site into all route channel IDs for the same model match.
   * Used for same-request site short-circuit after WAF/timeout/5xx/pool-down.
   */
  async listChannelIdsForSite(
    requestedModel: string,
    siteId: number,
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<number[]> {
    const normalizedSiteId = Math.trunc(siteId || 0);
    if (normalizedSiteId <= 0) return [];
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return [];
    const match = await this.findRoute(requestedModel, downstreamPolicy);
    if (!match) return [];
    return match.channels
      .filter((candidate) => candidate.site.id === normalizedSiteId)
      .map((candidate) => candidate.channel.id);
  }

  async selectPreferredChannel(
    requestedModel: string,
    preferredChannelId: number,
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
    excludeChannelIds: number[] = [],
    options?: PreferredChannelSelectionOptions,
  ): Promise<SelectedChannel | null> {
    if (!isModelAllowedByDownstreamPolicy(requestedModel, downstreamPolicy)) return null;
    const normalizedPreferredChannelId = Math.trunc(preferredChannelId || 0);
    if (normalizedPreferredChannelId <= 0) return null;
    await ensureSiteRuntimeHealthStateLoaded();

    const match = await this.findRoute(requestedModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectPreferredFromMatch(
      match,
      requestedModel,
      normalizedPreferredChannelId,
      downstreamPolicy,
      excludeChannelIds,
      true,
      options,
    );
  }

  async explainSelection(
    requestedModel: string,
    excludeChannelIds: number[] = [],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<RouteDecisionExplanation> {
    await ensureSiteRuntimeHealthStateLoaded();
    const match = await this.findRoute(requestedModel, downstreamPolicy);
    return await this.explainSelectionFromMatch(match, requestedModel, { excludeChannelIds, downstreamPolicy });
  }

  async explainSelectionForRoute(
    routeId: number,
    requestedModel: string,
    excludeChannelIds: number[] = [],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
  ): Promise<RouteDecisionExplanation> {
    await ensureSiteRuntimeHealthStateLoaded();
    const match = await this.findRouteById(routeId, downstreamPolicy);
    return await this.explainSelectionFromMatch(match, requestedModel, { excludeChannelIds, downstreamPolicy });
  }

  async explainSelectionRouteWide(routeId: number, downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY): Promise<RouteDecisionExplanation> {
    await ensureSiteRuntimeHealthStateLoaded();
    const match = await this.findRouteById(routeId, downstreamPolicy);
    const fallbackRequestedModel = match?.route.modelPattern || `route:${routeId}`;
    return await this.explainSelectionFromMatch(match, fallbackRequestedModel, {
      bypassSourceModelCheck: true,
      useChannelSourceModelForCost: true,
      downstreamPolicy,
    });
  }

  async refreshPricingReferenceCosts(
    requestedModel: string,
    options: PricingReferenceRefreshOptions = {},
  ): Promise<void> {
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;
    const match = await this.findRoute(requestedModel, downstreamPolicy);
    await this.refreshPricingReferenceCostsForMatch(match, requestedModel, options);
  }

  async refreshPricingReferenceCostsForRoute(
    routeId: number,
    requestedModel: string,
    options: PricingReferenceRefreshOptions = {},
  ): Promise<void> {
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;
    const match = await this.findRouteById(routeId, downstreamPolicy);
    await this.refreshPricingReferenceCostsForMatch(match, requestedModel, options);
  }

  async refreshRouteWidePricingReferenceCosts(
    routeId: number,
    options: Omit<PricingReferenceRefreshOptions, 'useChannelSourceModelForCost'> = {},
  ): Promise<void> {
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;
    const match = await this.findRouteById(routeId, downstreamPolicy);
    const requestedModel = match?.route.modelPattern || `route:${routeId}`;
    await this.refreshPricingReferenceCostsForMatch(match, requestedModel, {
      ...options,
      useChannelSourceModelForCost: true,
    });
  }

  private async explainSelectionFromMatch(
    match: RouteMatch | null,
    requestedModel: string,
    options: ExplainSelectionOptions = {},
  ): Promise<RouteDecisionExplanation> {
    const excludeChannelIds = options.excludeChannelIds ?? [];
    const downstreamPolicy = options.downstreamPolicy ?? DEFAULT_DOWNSTREAM_POLICY;

    if (!match) {
      return {
        requestedModel,
        actualModel: requestedModel,
        matched: false,
        summary: ['未匹配到启用的路由'],
        candidates: [],
      };
    }

    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const bypassSourceModelCheck = (options.bypassSourceModelCheck ?? false) || requestedByDisplayName;
    const useChannelSourceModelForCost = (options.useChannelSourceModelForCost ?? false) || requestedByDisplayName;
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const baseModelResolution = resolveModelResolution({
      requestedModel,
      route: match.route,
      modelMapping: match.route.modelMapping,
    });
    const routeStrategy = resolveRouteStrategy(match.route);
    const runtimeModelResolver = requestedByDisplayName
      ? ((candidate: RouteChannelCandidate) => normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
      : mappedModel;

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const summary: string[] = [
      `命中路由：${match.route.modelPattern}`,
      routeStrategy === 'round_robin'
        ? '路由策略：轮询'
        : (routeStrategy === 'stable_first' ? '路由策略：稳定优先' : '路由策略：按权重随机'),
    ];
    if (requestedByDisplayName) {
      summary.push(`按显示名命中：${normalizeRouteDisplayName(match.route.displayName)}`);
      summary.push('显示名仅用于聚合展示，实际转发模型按选中通道来源模型决定');
    }
    const available: RouteChannelCandidate[] = [];
    const candidates: RouteDecisionCandidate[] = [];
    const candidateMap = new Map<number, RouteDecisionCandidate>();

    for (const row of match.channels) {
      const eligibilityReasons = this.getCandidateEligibilityReasons(row, {
        requestedModel,
        bypassSourceModelCheck,
        excludeChannelIds,
        nowIso,
        downstreamPolicy,
      });

      const recentlyFailed = routeStrategy !== 'round_robin'
        ? isChannelRecentlyFailed(row.channel, nowMs)
        : false;
      const eligible = eligibilityReasons.length === 0;
      const reasonDetails = Object.fromEntries(
        eligibilityReasons
          .filter((item) => item.details !== undefined)
          .map((item) => [item.code, item.details]),
      );
      const candidate: RouteDecisionCandidate = {
        channelId: row.channel.id,
        accountId: row.account.id,
        username: row.account.username || `account-${row.account.id}`,
        siteId: row.site.id,
        siteName: row.site.name || 'unknown',
        tokenName: row.token?.name || 'default',
        priority: row.channel.priority ?? 0,
        weight: row.channel.weight ?? 10,
        eligible,
        recentlyFailed,
        avoidedByRecentFailure: false,
        probability: 0,
        reason: eligible ? '可用' : eligibilityReasons.map((item) => item.message).join('、'),
        reasonCodes: eligible ? ['eligible'] : eligibilityReasons.map((item) => item.code),
        reasonDetails: Object.keys(reasonDetails).length > 0 ? reasonDetails : undefined,
      };
      candidates.push(candidate);
      candidateMap.set(candidate.channelId, candidate);

      if (eligible) {
        available.push(row);
      }
    }

    if (available.length === 0) {
      summary.push('没有可用通道（全部被禁用、站点不可用、冷却或令牌不可用）');
      return {
        requestedModel,
        actualModel: mappedModel,
        matched: true,
        routeId: match.route.id,
        modelPattern: match.route.modelPattern,
        summary,
        candidates,
        modelResolution: baseModelResolution,
      };
    }

    // Match live selectFromMatch: soft-avoid known-disconnected channels before scoring.
    const connectivityLookup = await loadConnectivityLookup(
      available.map((candidate) => candidate.account.id),
      available
        .map((candidate) => candidate.channel.tokenId)
        .filter((tokenId): tokenId is number => typeof tokenId === 'number' && tokenId > 0),
      nowMs,
    );
    const connectivityResolve = (candidate: RouteChannelCandidate): ConnectivitySignal => (
      resolveCandidateConnectivity(connectivityLookup, {
        accountId: candidate.account.id,
        tokenId: candidate.channel.tokenId,
        modelNames: [
          candidate.channel.sourceModel,
          typeof runtimeModelResolver === 'function'
            ? runtimeModelResolver(candidate)
            : runtimeModelResolver,
          requestedModel,
          mappedModel,
        ],
      })
    );
    const connectivityFiltered = softAvoidDisconnectedCandidates(available, connectivityResolve);
    if (connectivityFiltered.avoided.length > 0) {
      for (const item of connectivityFiltered.avoided) {
        const target = candidateMap.get(item.candidate.channel.id);
        if (!target) continue;
        target.probability = 0;
        setCandidateDecisionReason(target, 'connectivity_avoided', item.reason);
      }
      summary.push(`连通性软避让 ${connectivityFiltered.avoided.length}`);
    }
    const routePool = connectivityFiltered.candidates;

    if (routeStrategy === 'round_robin') {
      const layers = new Map<number, RouteChannelCandidate[]>();
      for (const candidate of routePool) {
        const priority = candidate.channel.priority ?? 0;
        if (!layers.has(priority)) layers.set(priority, []);
        layers.get(priority)!.push(candidate);
      }
      const sortedPriorities = [...layers.keys()].sort((left, right) => left - right);
      let selected: RouteChannelCandidate | null = null;
      let selectedPriority = 0;
      let ordered: RouteChannelCandidate[] = [];
      for (const [layerIndex, priority] of sortedPriorities.entries()) {
        const rawLayer = this.getRoundRobinCandidates(layers.get(priority) ?? []);
        const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawLayer, runtimeModelResolver, nowMs);
        for (const item of breakerFiltered.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (target) setCandidateDecisionReason(target, 'runtime_health_avoided', item.reason);
        }
        const hasFreshCandidate = breakerFiltered.candidates.some(
          (candidate) => !isChannelRecentlyFailed(candidate.channel, nowMs),
        );
        if (!hasFreshCandidate && layerIndex < sortedPriorities.length - 1) continue;
        ordered = this.getRoundRobinCandidates(filterRecentlyFailedCandidates(breakerFiltered.candidates, nowMs));
        if (ordered.length === 0) continue;
        selected = ordered[0] ?? null;
        selectedPriority = priority;
        break;
      }

      for (const candidate of candidates) {
        if ((candidate.priority ?? 0) > selectedPriority && candidate.eligible) {
          setCandidateDecisionReason(candidate, 'round_robin_waiting', `等待更高优先级 P${selectedPriority} 耗尽`, {
            selectedPriority,
          });
        }
      }
      for (let index = 0; index < ordered.length; index += 1) {
        const target = candidateMap.get(ordered[index].channel.id);
        if (!target || !target.eligible) continue;
        target.probability = index === 0 ? 100 : 0;
        setCandidateDecisionReason(
          target,
          index === 0 ? 'round_robin_selected' : 'round_robin_waiting',
          index === 0
            ? `P${selectedPriority} 层内轮询命中（第 1 / ${ordered.length} 位）`
            : `P${selectedPriority} 层内轮询排队（第 ${index + 1} / ${ordered.length} 位）`,
          { priority: selectedPriority, position: index + 1, candidateCount: ordered.length },
        );
      }

      if (!selected) {
        summary.push('本次未选出通道');
        return {
          requestedModel,
          actualModel: mappedModel,
          matched: true,
          routeId: match.route.id,
          modelPattern: match.route.modelPattern,
          summary,
          candidates,
        };
      }

      const selectedChannel = candidateMap.get(selected.channel.id);
      const selectedLabel = selectedChannel
        ? `${selectedChannel.username} @ ${selectedChannel.siteName} / ${selectedChannel.tokenName}`
        : `channel-${selected.channel.id}`;
      const modelResolution = resolveModelResolution({
        requestedModel,
        route: match.route,
        modelMapping: match.route.modelMapping,
        channelSourceModel: selected.channel.sourceModel,
      });
      const actualModel = modelResolution.upstreamModel;
      summary.push(`分层轮询：P${selectedPriority} 可用 ${ordered.length}`);
      summary.push(`最终选择：${selectedLabel}`);
      if (actualModel !== mappedModel) {
        summary.push(`实际转发模型：${actualModel}`);
      }

      return {
        requestedModel,
        actualModel,
        matched: true,
        routeId: match.route.id,
        modelPattern: match.route.modelPattern,
        selectedChannelId: selected.channel.id,
        selectedAccountId: selected.account.id,
        selectedLabel,
        summary,
        candidates,
        modelResolution,
      };
    }

    if (routeStrategy === 'stable_first') {
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(routePool, runtimeModelResolver, nowMs);
      if (breakerFiltered.avoided.length > 0) {
        for (const item of breakerFiltered.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          setCandidateDecisionReason(target, 'runtime_health_avoided', item.reason);
        }
      }

      const filteredCandidates = filterRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      const avoided = breakerFiltered.candidates.filter((row) => !filteredCandidates.some((item) => item.channel.id === row.channel.id));
      if (avoided.length > 0) {
        for (const row of avoided) {
          const target = candidateMap.get(row.channel.id);
          if (!target) continue;
          target.avoidedByRecentFailure = true;
          setCandidateDecisionReason(target, 'recent_failure_avoided', `最近失败，优先避让（${resolveFailureBackoffSec(row.channel.failCount)} 秒窗口）`, {
            failCount: row.channel.failCount ?? 0,
            cooldownSeconds: resolveFailureBackoffSec(row.channel.failCount),
          });
        }
      }

      const rotationKey = this.buildStableFirstRotationKey(match.route.id, requestedModel);
      const poolPlan = buildStableFirstPoolPlan(
        filteredCandidates,
        useChannelSourceModelForCost ? runtimeModelResolver : mappedModel,
        nowMs,
      );
      const observationDueNow = poolPlan.observationCandidates.length > 0
        && shouldUseStableFirstObservationCandidate(rotationKey, poolPlan.observationCandidates, nowMs);
      const useObservationNow = poolPlan.observationCandidates.length > 0
        && (poolPlan.primaryCandidates.length <= 0 || observationDueNow);
      const observationProgressState = getStableFirstObservationProgressByKey().get(rotationKey) ?? {
        requestCount: 0,
        lastObservationAtMs: null,
      };
      const remainingPrimaryRequestsBeforeObservation = poolPlan.primaryCandidates.length > 0
        ? Math.max(0, STABLE_FIRST_OBSERVATION_REQUEST_INTERVAL - (observationProgressState.requestCount + 1))
        : 0;
      const observationBlockedByCooldown = poolPlan.primaryCandidates.length > 0
        && poolPlan.observationCandidates.length > 0
        && remainingPrimaryRequestsBeforeObservation === 0
        && !observationDueNow;
      const primaryWeighted = this.calculateWeightedSelection(
        poolPlan.primaryCandidates,
        useChannelSourceModelForCost ? runtimeModelResolver : mappedModel,
        downstreamPolicy,
        nowMs,
        'stable_first',
        rotationKey,
      );
      const observationWeighted = poolPlan.observationCandidates.length > 0
        ? this.calculateWeightedSelection(
          poolPlan.observationCandidates,
          useChannelSourceModelForCost ? runtimeModelResolver : mappedModel,
          downstreamPolicy,
          nowMs,
          'stable_first',
          `${rotationKey}:observe`,
        )
        : {
          selected: null,
          details: [],
          stableSiteCount: 0,
        };

      for (const detail of primaryWeighted.details) {
        const target = candidateMap.get(detail.candidate.channel.id);
        if (!target) continue;
        target.probability = Number((detail.probability * (useObservationNow ? 0 : 100)).toFixed(2));
        if (target.eligible && !target.avoidedByRecentFailure) {
          setCandidateDecisionReason(
            target,
            'stable_first_scored',
            useObservationNow
              ? `主池：本次让位给观察池灰度请求；${detail.reason}`
              : `主池：${detail.reason}`,
            { probability: target.probability, pool: 'primary' },
          );
        }
      }
      for (const detail of observationWeighted.details) {
        const target = candidateMap.get(detail.candidate.channel.id);
        if (!target) continue;
        target.probability = Number((detail.probability * (useObservationNow ? 100 : 0)).toFixed(2));
        if (target.eligible && !target.avoidedByRecentFailure) {
          const siteState = poolPlan.siteStateById.get(detail.candidate.site.id);
          const observationWindowPrefix = useObservationNow
            ? (poolPlan.primaryCandidates.length > 0
              ? '本次命中灰度真实请求'
              : '当前主池为空，改由观察池承接')
            : (observationBlockedByCooldown
              ? '当前已到灰度窗口，但观察站点仍在冷却'
              : `当前还需 ${remainingPrimaryRequestsBeforeObservation} 次主池请求`);
          setCandidateDecisionReason(
            target,
            'stable_first_scored',
            poolPlan.observationSiteIds.has(detail.candidate.site.id)
              ? `${siteState?.observationReason || '观察池'}；${observationWindowPrefix}；${detail.reason}`
              : `观察池：${observationWindowPrefix}；${detail.reason}`,
            { probability: target.probability, pool: 'observation' },
          );
        }
      }

      const weighted = useObservationNow
        ? observationWeighted
        : (primaryWeighted.selected ? primaryWeighted : observationWeighted);
      if (!weighted.selected) {
        summary.push('本次未选出通道');
        return {
          requestedModel,
          actualModel: mappedModel,
          matched: true,
          routeId: match.route.id,
          modelPattern: match.route.modelPattern,
          summary,
          candidates,
        };
      }

      const summaryParts = [`稳定优先：可用 ${routePool.length}`];
      if (poolPlan.primarySiteIds.size > 0) {
        summaryParts.push(`主池站点 ${poolPlan.primarySiteIds.size}`);
      }
      if (poolPlan.observationSiteIds.size > 0) {
        summaryParts.push(`观察池站点 ${poolPlan.observationSiteIds.size}`);
      }
      summaryParts.push('按近期成功率分层后按配置顺序轮询站点');
      if (poolPlan.observationSiteIds.size > 0) {
        if (useObservationNow) {
          summaryParts.push('本次命中观察池灰度流量');
        } else if (observationBlockedByCooldown) {
          summaryParts.push('观察池已到灰度窗口，但候选站点仍在观察冷却');
        } else if (poolPlan.primaryCandidates.length <= 0) {
          summaryParts.push('当前主池为空，由观察池承接流量');
        } else {
          summaryParts.push(`观察池仅消耗少量真实请求灰度流量（当前还需 ${remainingPrimaryRequestsBeforeObservation} 次主池请求）`);
        }
      }
      if (breakerFiltered.avoided.length > 0) {
        const breakerSummaryLabel = breakerFiltered.avoided.some((item) => item.reason.includes('模型熔断'))
          ? '运行时熔断避让'
          : '站点熔断避让';
        summaryParts.push(`${breakerSummaryLabel} ${breakerFiltered.avoided.length}`);
      }
      if (avoided.length > 0) {
        summaryParts.push(`最近失败避让 ${avoided.length}`);
      }
      summary.push(summaryParts.join('，'));

      const selectedChannel = candidateMap.get(weighted.selected.channel.id);
      const selectedLabel = selectedChannel
        ? `${selectedChannel.username} @ ${selectedChannel.siteName} / ${selectedChannel.tokenName}`
        : `channel-${weighted.selected.channel.id}`;
      const modelResolution = resolveModelResolution({
        requestedModel,
        route: match.route,
        modelMapping: match.route.modelMapping,
        channelSourceModel: weighted.selected.channel.sourceModel,
      });
      const actualModel = modelResolution.upstreamModel;
      summary.push(`最终选择：${selectedLabel}（P${weighted.selected.channel.priority ?? 0}）`);
      if (actualModel !== mappedModel) {
        summary.push(`实际转发模型：${actualModel}`);
      }

      return {
        requestedModel,
        actualModel,
        matched: true,
        routeId: match.route.id,
        modelPattern: match.route.modelPattern,
        selectedChannelId: weighted.selected.channel.id,
        selectedAccountId: weighted.selected.account.id,
        selectedLabel,
        summary,
        candidates,
        modelResolution,
      };
    }

    const availableByPriority = new Map<number, RouteChannelCandidate[]>();
    for (const row of routePool) {
      const priority = row.channel.priority ?? 0;
      if (!availableByPriority.has(priority)) availableByPriority.set(priority, []);
      availableByPriority.get(priority)!.push(row);
    }

    const sortedPriorities = Array.from(availableByPriority.keys()).sort((a, b) => a - b);
    let selected: RouteChannelCandidate | null = null;
    let selectedPriority = 0;

    for (const priority of sortedPriorities) {
      const rawLayer = availableByPriority.get(priority) ?? [];
      if (rawLayer.length === 0) continue;

      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawLayer, runtimeModelResolver, nowMs);
      if (breakerFiltered.avoided.length > 0) {
        for (const item of breakerFiltered.avoided) {
          const target = candidateMap.get(item.candidate.channel.id);
          if (!target) continue;
          target.probability = 0;
          setCandidateDecisionReason(target, 'runtime_health_avoided', item.reason);
        }
      }

      const filteredLayer = filterRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      const avoided = breakerFiltered.candidates.filter((row) => !filteredLayer.some((item) => item.channel.id === row.channel.id));
      if (avoided.length > 0) {
        for (const row of avoided) {
          const target = candidateMap.get(row.channel.id);
          if (!target) continue;
          target.avoidedByRecentFailure = true;
          target.probability = 0;
          setCandidateDecisionReason(
            target,
            'recent_failure_avoided',
            `最近失败，优先避让（${resolveFailureBackoffSec(row.channel.failCount)} 秒窗口）`,
            {
              failCount: row.channel.failCount ?? 0,
              cooldownSeconds: resolveFailureBackoffSec(row.channel.failCount),
            },
          );
        }
      }

      // Match live weighted selection: balanced-v2 (connectivity + credential + protocol affinity).
      const modelForCost = useChannelSourceModelForCost ? runtimeModelResolver : mappedModel;
      const shadowInputs = this.buildShadowCandidateInputs(
        filteredLayer,
        modelForCost,
        downstreamPolicy,
        nowMs,
        connectivityLookup,
        requestedModel,
      );
      const ranked = rankShadowCandidates(shadowInputs);
      const byChannelId = new Map(ranked.candidates.map((row) => [row.channelId, row]));
      for (const row of filteredLayer) {
        const target = candidateMap.get(row.channel.id);
        if (!target) continue;
        const scored = byChannelId.get(row.channel.id);
        if (!scored) {
          target.probability = 0;
          continue;
        }
        target.probability = Number((scored.probability * 100).toFixed(2));
        if (target.eligible && !target.avoidedByRecentFailure) {
          const connText = scored.factors.connectivity >= 1.2
            ? '通'
            : (scored.factors.connectivity <= 0.2 ? '不通' : '未知');
          setCandidateDecisionReason(
            target,
            'weighted_scored',
            `balanced-v2（W=${row.channel.weight ?? 10}，凭证=${scored.factors.credential.toFixed(2)}，`
              + `余额=${scored.factors.balance.toFixed(2)}，成本=${scored.factors.cost.toFixed(2)}，`
              + `可靠=${scored.factors.reliability.toFixed(2)}，健康=${scored.factors.health.toFixed(2)}，`
              + `连通=${scored.factors.connectivity.toFixed(2)}(${connText})，`
              + `协议=${scored.factors.protocolAffinity.toFixed(2)}，负载=${scored.factors.load.toFixed(2)}，`
              + `概率≈${(scored.probability * 100).toFixed(1)}%）`,
            {
              probability: target.probability,
              factors: scored.factors,
            },
          );
        }
      }

      const selectedId = ranked.selectedChannelId;
      selected = filteredLayer.find((row) => row.channel.id === selectedId)
        ?? filteredLayer[0]
        ?? null;
      if (!selected) continue;
      selectedPriority = priority;
      const layerSummaryParts = [`优先级 P${priority}：可用 ${rawLayer.length}`];
      if (breakerFiltered.avoided.length > 0) {
        const breakerSummaryLabel = breakerFiltered.avoided.some((item) => item.reason.includes('模型熔断'))
          ? '运行时熔断避让'
          : '站点熔断避让';
        layerSummaryParts.push(`${breakerSummaryLabel} ${breakerFiltered.avoided.length}`);
      }
      if (avoided.length > 0) {
        layerSummaryParts.push(`最近失败避让 ${avoided.length}`);
      }
      layerSummaryParts.push('评分=balanced-v2');
      summary.push(layerSummaryParts.join('，'));
      break;
    }

    if (!selected) {
      summary.push('本次未选出通道');
      return {
        requestedModel,
        actualModel: mappedModel,
        matched: true,
        routeId: match.route.id,
        modelPattern: match.route.modelPattern,
        summary,
        candidates,
        modelResolution: baseModelResolution,
      };
    }

    const selectedChannel = candidateMap.get(selected.channel.id);
    const selectedLabel = selectedChannel
      ? `${selectedChannel.username} @ ${selectedChannel.siteName} / ${selectedChannel.tokenName}`
      : `channel-${selected.channel.id}`;
    const modelResolution = resolveModelResolution({
      requestedModel,
      route: match.route,
      modelMapping: match.route.modelMapping,
      channelSourceModel: selected.channel.sourceModel,
    });
    const actualModel = modelResolution.upstreamModel;
    summary.push(`最终选择：${selectedLabel}（P${selectedPriority}）`);
    if (actualModel !== mappedModel) {
      summary.push(`实际转发模型：${actualModel}`);
    }

    return {
      requestedModel,
      actualModel,
      matched: true,
      routeId: match.route.id,
      modelPattern: match.route.modelPattern,
      selectedChannelId: selected.channel.id,
      selectedAccountId: selected.account.id,
      selectedLabel,
      summary,
      candidates,
      modelResolution,
    };
  }

  private async refreshPricingReferenceCostsForMatch(
    match: RouteMatch | null,
    requestedModel: string,
    options: PricingReferenceRefreshOptions = {},
  ): Promise<void> {
    if (!match) return;

    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const useChannelSourceModelForCost = (options.useChannelSourceModelForCost ?? false) || requestedByDisplayName;
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const refreshedKeys = options.refreshedKeys ?? new Set<string>();

    await Promise.allSettled(match.channels.map(async (candidate) => {
      const refreshKey = `${candidate.site.id}:${candidate.account.id}`;
      if (refreshedKeys.has(refreshKey)) return;
      refreshedKeys.add(refreshKey);

      const modelName = useChannelSourceModelForCost
        ? (normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
        : mappedModel;
      if (!modelName) return;

      await refreshModelPricingCatalog({
        site: {
          id: candidate.site.id,
          url: candidate.site.url,
          platform: candidate.site.platform,
          apiKey: candidate.site.apiKey,
        },
        account: {
          id: candidate.account.id,
          accessToken: candidate.account.accessToken,
          apiToken: candidate.account.apiToken,
        },
        modelName,
      });
    }));
  }

  /**
   * Record success for a channel.
   */
  async recordSuccess(
    channelId: number,
    latencyMs: number,
    cost: number,
    modelName?: string | null,
    actualAccountId?: number,
  ) {
    await ensureSiteRuntimeHealthStateLoaded();
    const row = await db.select()
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .where(eq(schema.routeChannels.id, channelId))
      .get();
    if (!row) return;
    const ch = row.route_channels;
    const account = row.accounts;
    const nowIso = new Date().toISOString();
    const nextSuccessCount = (ch.successCount ?? 0) + 1;
    const nextTotalLatencyMs = (ch.totalLatencyMs ?? 0) + latencyMs;
    const nextTotalCost = (ch.totalCost ?? 0) + cost;
    if (typeof ch.oauthRouteUnitId === 'number' && ch.oauthRouteUnitId > 0) {
      const targetAccountId = Number.isFinite(actualAccountId) && (actualAccountId ?? 0) > 0
        ? Math.trunc(actualAccountId!)
        : account.id;
      const memberRow = await db.select({
        member: schema.oauthRouteUnitMembers,
        account: schema.accounts,
      }).from(schema.oauthRouteUnitMembers)
        .innerJoin(schema.accounts, eq(schema.oauthRouteUnitMembers.accountId, schema.accounts.id))
        .where(and(
          eq(schema.oauthRouteUnitMembers.unitId, ch.oauthRouteUnitId),
          eq(schema.oauthRouteUnitMembers.accountId, targetAccountId),
        ))
        .get();

      if (memberRow) {
        const memberSuccessCount = (memberRow.member.successCount ?? 0) + 1;
        const memberTotalLatencyMs = (memberRow.member.totalLatencyMs ?? 0) + latencyMs;
        const memberTotalCost = (memberRow.member.totalCost ?? 0) + cost;
        await db.update(schema.oauthRouteUnitMembers).set({
          successCount: memberSuccessCount,
          totalLatencyMs: memberTotalLatencyMs,
          totalCost: memberTotalCost,
          lastUsedAt: nowIso,
          failCount: 0,
          cooldownUntil: null,
          lastFailAt: null,
          consecutiveFailCount: 0,
          cooldownLevel: 0,
          updatedAt: nowIso,
        }).where(eq(schema.oauthRouteUnitMembers.id, memberRow.member.id)).run();
        recordSiteRuntimeSuccess(memberRow.account.siteId, latencyMs, modelName);
      } else {
        recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName);
      }
      invalidateRouteScopedCache(ch.routeId);
    } else {
      recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName);
    }

    await db.update(schema.routeChannels).set({
      successCount: nextSuccessCount,
      totalLatencyMs: nextTotalLatencyMs,
      totalCost: nextTotalCost,
      lastUsedAt: nowIso,
      failCount: 0,
      cooldownUntil: null,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    }).where(eq(schema.routeChannels.id, channelId)).run();

    patchCachedChannel(channelId, (channel) => {
      channel.successCount = nextSuccessCount;
      channel.totalLatencyMs = nextTotalLatencyMs;
      channel.totalCost = nextTotalCost;
      channel.lastUsedAt = nowIso;
      channel.failCount = 0;
      channel.cooldownUntil = null;
      channel.lastFailAt = null;
      channel.consecutiveFailCount = 0;
      channel.cooldownLevel = 0;
    });
  }

  async recordProbeSuccess(
    channelId: number,
    latencyMs: number,
    modelName?: string | null,
    actualAccountId?: number,
  ) {
    await ensureSiteRuntimeHealthStateLoaded();
    const row = await db.select()
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .where(eq(schema.routeChannels.id, channelId))
      .get();
    if (!row) return;

    const ch = row.route_channels;
    const account = row.accounts;
    if (typeof ch.oauthRouteUnitId === 'number' && ch.oauthRouteUnitId > 0) {
      const targetAccountId = Number.isFinite(actualAccountId) && (actualAccountId ?? 0) > 0
        ? Math.trunc(actualAccountId!)
        : account.id;
      const nowIso = new Date().toISOString();
      const memberRow = await db.select({
        member: schema.oauthRouteUnitMembers,
        account: schema.accounts,
      }).from(schema.oauthRouteUnitMembers)
        .innerJoin(schema.accounts, eq(schema.oauthRouteUnitMembers.accountId, schema.accounts.id))
        .where(and(
          eq(schema.oauthRouteUnitMembers.unitId, ch.oauthRouteUnitId),
          eq(schema.oauthRouteUnitMembers.accountId, targetAccountId),
        ))
        .get();

      if (memberRow) {
        await db.update(schema.oauthRouteUnitMembers).set({
          cooldownUntil: null,
          lastFailAt: null,
          consecutiveFailCount: 0,
          cooldownLevel: 0,
          updatedAt: nowIso,
        }).where(eq(schema.oauthRouteUnitMembers.id, memberRow.member.id)).run();
        recordSiteRuntimeSuccess(memberRow.account.siteId, latencyMs, modelName);
      } else {
        recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName);
      }

      await db.update(schema.routeChannels).set({
        cooldownUntil: null,
        lastFailAt: null,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      }).where(eq(schema.routeChannels.id, channelId)).run();
      patchCachedChannel(channelId, (channel) => {
        channel.cooldownUntil = null;
        channel.lastFailAt = null;
        channel.consecutiveFailCount = 0;
        channel.cooldownLevel = 0;
      });
      invalidateRouteScopedCache(ch.routeId);
      return;
    }

    const affectedChannelIds = await loadCredentialScopedChannelIds(ch, account.id);
    const needsChannelReset = !!ch.cooldownUntil
      || !!ch.lastFailAt
      || (ch.consecutiveFailCount ?? 0) > 0
      || (ch.cooldownLevel ?? 0) > 0;

    if (needsChannelReset) {
      await db.update(schema.routeChannels).set({
        cooldownUntil: null,
        lastFailAt: null,
        consecutiveFailCount: 0,
        cooldownLevel: 0,
      }).where(inArray(schema.routeChannels.id, affectedChannelIds)).run();

      for (const affectedChannelId of affectedChannelIds) {
        patchCachedChannel(affectedChannelId, (channel) => {
          channel.cooldownUntil = null;
          channel.lastFailAt = null;
          channel.consecutiveFailCount = 0;
          channel.cooldownLevel = 0;
        });
      }
    } else if (affectedChannelIds.length > 1) {
      const scopedRows = await db.select({
        id: schema.routeChannels.id,
        cooldownUntil: schema.routeChannels.cooldownUntil,
        lastFailAt: schema.routeChannels.lastFailAt,
        consecutiveFailCount: schema.routeChannels.consecutiveFailCount,
        cooldownLevel: schema.routeChannels.cooldownLevel,
      })
        .from(schema.routeChannels)
        .where(inArray(schema.routeChannels.id, affectedChannelIds))
        .all();
      const siblingIdsToReset = scopedRows
        .filter((candidate: any) => candidate.id !== channelId && (
          !!candidate.cooldownUntil
          || !!candidate.lastFailAt
          || (candidate.consecutiveFailCount ?? 0) > 0
          || (candidate.cooldownLevel ?? 0) > 0
        ))
        .map((candidate: any) => candidate.id);

      if (siblingIdsToReset.length > 0) {
        await db.update(schema.routeChannels).set({
          cooldownUntil: null,
          lastFailAt: null,
          consecutiveFailCount: 0,
          cooldownLevel: 0,
        }).where(inArray(schema.routeChannels.id, siblingIdsToReset)).run();

        for (const siblingId of siblingIdsToReset) {
          patchCachedChannel(siblingId, (channel) => {
            channel.cooldownUntil = null;
            channel.lastFailAt = null;
            channel.consecutiveFailCount = 0;
            channel.cooldownLevel = 0;
          });
        }
      }
    }

    recordSiteRuntimeSuccess(account.siteId, latencyMs, modelName);
  }

  /**
   * Clear persisted failure and cooldown state for the given channels.
   */
  async clearChannelFailureState(channelIds: number[]): Promise<number> {
    const normalizedChannelIds = Array.from(new Set(
      channelIds
        .filter((channelId): channelId is number => Number.isFinite(channelId) && channelId > 0)
        .map((channelId) => Math.trunc(channelId)),
    ));
    if (normalizedChannelIds.length === 0) return 0;

    await ensureSiteRuntimeHealthStateLoaded();
    const runtimeHealthRows = await db.select({
      siteId: schema.accounts.siteId,
      accountId: schema.routeChannels.accountId,
      tokenId: schema.routeChannels.tokenId,
      sourceModel: schema.routeChannels.sourceModel,
      routeModelPattern: schema.tokenRoutes.modelPattern,
    }).from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .where(inArray(schema.routeChannels.id, normalizedChannelIds))
      .all();

    const result = await db.update(schema.routeChannels).set({
      failCount: 0,
      lastFailAt: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
      cooldownUntil: null,
    }).where(inArray(schema.routeChannels.id, normalizedChannelIds)).run();

    // Manual cooldown clearing means "allow a fresh attempt", not "proven
    // healthy". Reset only matching false connectivity evidence to unknown so
    // the channel can re-enter selection without fabricating a successful probe.
    const accountModels = new Map<number, Set<string>>();
    const tokenModels = new Map<number, Set<string>>();
    for (const row of runtimeHealthRows) {
      const modelNames = [row.sourceModel, row.routeModelPattern]
        .map((value) => String(value || '').trim())
        .filter((value) => value && !value.toLowerCase().startsWith('re:') && !/[?*]/.test(value));
      if (modelNames.length === 0) continue;
      if (!accountModels.has(row.accountId)) accountModels.set(row.accountId, new Set());
      for (const modelName of modelNames) accountModels.get(row.accountId)!.add(modelName);
      if (typeof row.tokenId === 'number' && row.tokenId > 0) {
        if (!tokenModels.has(row.tokenId)) tokenModels.set(row.tokenId, new Set());
        for (const modelName of modelNames) tokenModels.get(row.tokenId)!.add(modelName);
      }
    }
    for (const [accountId, modelNames] of accountModels) {
      await db.update(schema.modelAvailability)
        .set({ connectivity: null })
        .where(and(
          eq(schema.modelAvailability.accountId, accountId),
          eq(schema.modelAvailability.connectivity, false),
          inArray(sql<string>`lower(trim(${schema.modelAvailability.modelName}))`, [...modelNames].map((name) => name.toLowerCase())),
        ))
        .run();
    }
    for (const [tokenId, modelNames] of tokenModels) {
      await db.update(schema.tokenModelAvailability)
        .set({ connectivity: null })
        .where(and(
          eq(schema.tokenModelAvailability.tokenId, tokenId),
          eq(schema.tokenModelAvailability.connectivity, false),
          inArray(sql<string>`lower(trim(${schema.tokenModelAvailability.modelName}))`, [...modelNames].map((name) => name.toLowerCase())),
        ))
        .run();
    }

    if (clearRuntimeHealthStatesForChannels(runtimeHealthRows)) {
      await persistSiteRuntimeHealthState();
    }

    invalidateTokenRouterCache();
    return Number(result?.changes || normalizedChannelIds.length);
  }

  /**
   * Record failure and set cooldown.
   */
  async recordFailure(
    channelId: number,
    context: SiteRuntimeFailureContext | string | null = {},
    actualAccountId?: number,
  ) {
    await ensureSiteRuntimeHealthStateLoaded();
    const row = await db.select()
      .from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
      .where(eq(schema.routeChannels.id, channelId))
      .get();
    if (!row) return;

    const ch = row.route_channels;
    const account = row.accounts;
    const route = row.token_routes;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const normalizedContext: SiteRuntimeFailureContext = typeof context === 'string'
      ? { modelName: context }
      : (context ?? {});
    if (typeof ch.oauthRouteUnitId === 'number' && ch.oauthRouteUnitId > 0) {
      const targetAccountId = Number.isFinite(actualAccountId) && (actualAccountId ?? 0) > 0
        ? Math.trunc(actualAccountId!)
        : account.id;
      const memberRow = await db.select({
        member: schema.oauthRouteUnitMembers,
        account: schema.accounts,
        unit: schema.oauthRouteUnits,
      }).from(schema.oauthRouteUnitMembers)
        .innerJoin(schema.accounts, eq(schema.oauthRouteUnitMembers.accountId, schema.accounts.id))
        .innerJoin(schema.oauthRouteUnits, eq(schema.oauthRouteUnitMembers.unitId, schema.oauthRouteUnits.id))
        .where(and(
          eq(schema.oauthRouteUnitMembers.unitId, ch.oauthRouteUnitId),
          eq(schema.oauthRouteUnitMembers.accountId, targetAccountId),
        ))
        .get();
      if (memberRow) {
        const shortWindowLimitCooldownUntil = resolveShortWindowLimitCooldown(memberRow.account, normalizedContext, nowMs);
        const failCount = shortWindowLimitCooldownUntil ? 0 : ((memberRow.member.failCount ?? 0) + 1);
        const routeUnitStrategy = memberRow.unit.strategy === 'stick_until_unavailable'
          ? 'stick_until_unavailable'
          : 'round_robin';
        let cooldownUntil: string | null = null;
        let consecutiveFailCount = Math.max(0, memberRow.member.consecutiveFailCount ?? 0) + 1;
        let cooldownLevel = Math.max(0, memberRow.member.cooldownLevel ?? 0);

        const cooldownPolicy = resolveFailureCooldownWeight(normalizedContext);
        if (shortWindowLimitCooldownUntil) {
          cooldownUntil = shortWindowLimitCooldownUntil;
          consecutiveFailCount = 0;
          cooldownLevel = 0;
        } else if (cooldownPolicy.skipCooldown) {
          cooldownUntil = null;
          consecutiveFailCount = 0;
          cooldownLevel = 0;
        } else if (routeUnitStrategy === 'round_robin') {
          if (consecutiveFailCount >= ROUND_ROBIN_FAILURE_THRESHOLD) {
            cooldownLevel = Math.min(cooldownLevel + 1, ROUND_ROBIN_COOLDOWN_LEVELS_SEC.length - 1);
            const cooldownSec = resolveRoundRobinCooldownSec(cooldownLevel);
            cooldownUntil = cooldownSec > 0
              ? new Date(nowMs + clampFailureCooldownMs(cooldownSec * 1000 * cooldownPolicy.weight)).toISOString()
              : null;
            consecutiveFailCount = 0;
          }
        } else {
          const failureDecision = classifyProxyFailure(normalizedContext);
          if (failureDecision.class === 'endpoint_pool_down') {
            // Align with the endpoint pool cooldown (see the non-oauth branch).
            cooldownUntil = new Date(nowMs + SITE_API_ENDPOINT_COOLDOWN_MS).toISOString();
          } else {
            cooldownUntil = new Date(nowMs + resolveEffectiveFailureCooldownMs(failCount, cooldownPolicy.weight)).toISOString();
          }
          consecutiveFailCount = 0;
          cooldownLevel = 0;
        }

        await db.update(schema.oauthRouteUnitMembers).set({
          failCount,
          lastFailAt: nowIso,
          consecutiveFailCount,
          cooldownLevel,
          cooldownUntil,
          updatedAt: nowIso,
        }).where(eq(schema.oauthRouteUnitMembers.id, memberRow.member.id)).run();
        recordSiteRuntimeFailure(memberRow.account.siteId, normalizedContext, nowMs);
        invalidateRouteScopedCache(route.id);
        return;
      }
    }

    const shortWindowLimitCooldownUntil = resolveShortWindowLimitCooldown(account, normalizedContext, nowMs);
    const failCount = shortWindowLimitCooldownUntil ? 0 : ((ch.failCount ?? 0) + 1);
    const routeStrategy = resolveRouteStrategy(route);
    const affectedChannelIds = shortWindowLimitCooldownUntil
      ? await loadCredentialScopedChannelIds(ch, account.id)
      : [channelId];
    let cooldownUntil: string | null = null;
    let consecutiveFailCount = Math.max(0, ch.consecutiveFailCount ?? 0) + 1;
    let cooldownLevel = Math.max(0, ch.cooldownLevel ?? 0);

    const cooldownPolicy = resolveFailureCooldownWeight(normalizedContext);
    if (shortWindowLimitCooldownUntil) {
      cooldownUntil = shortWindowLimitCooldownUntil;
      consecutiveFailCount = 0;
      cooldownLevel = 0;
    } else if (cooldownPolicy.skipCooldown) {
      cooldownUntil = null;
      consecutiveFailCount = 0;
      cooldownLevel = 0;
    } else if (routeStrategy === 'round_robin') {
      if (consecutiveFailCount >= ROUND_ROBIN_FAILURE_THRESHOLD) {
        cooldownLevel = Math.min(cooldownLevel + 1, ROUND_ROBIN_COOLDOWN_LEVELS_SEC.length - 1);
        const cooldownSec = resolveRoundRobinCooldownSec(cooldownLevel);
        cooldownUntil = cooldownSec > 0
          ? new Date(nowMs + clampFailureCooldownMs(cooldownSec * 1000 * cooldownPolicy.weight)).toISOString()
          : null;
        consecutiveFailCount = 0;
      }
    } else {
      const failureDecision = classifyProxyFailure(normalizedContext);
      if (failureDecision.class === 'endpoint_pool_down') {
        // Every API endpoint for this site is in cooldown. The channel-level
        // backoff must align with the endpoint pool cooldown (5 min) instead
        // of the short fibonacci backoff, otherwise the router keeps picking
        // the site after 15s while its endpoints are still cooling down and
        // every pick fails in ~1ms (endpoint_all_down). Reusing the endpoint
        // cooldown constant keeps both systems in sync without extra state.
        cooldownUntil = new Date(nowMs + SITE_API_ENDPOINT_COOLDOWN_MS).toISOString();
      } else {
        cooldownUntil = new Date(nowMs + resolveEffectiveFailureCooldownMs(failCount, cooldownPolicy.weight)).toISOString();
      }
      consecutiveFailCount = 0;
      cooldownLevel = 0;
    }

    await db.update(schema.routeChannels).set({
      failCount,
      lastFailAt: nowIso,
      consecutiveFailCount,
      cooldownLevel,
      cooldownUntil,
    }).where(inArray(schema.routeChannels.id, affectedChannelIds)).run();

    for (const affectedChannelId of affectedChannelIds) {
      patchCachedChannel(affectedChannelId, (channel) => {
        channel.failCount = failCount;
        channel.lastFailAt = nowIso;
        channel.cooldownUntil = cooldownUntil;
        channel.consecutiveFailCount = consecutiveFailCount;
        channel.cooldownLevel = cooldownLevel;
      });
    }

    recordSiteRuntimeFailure(account.siteId, normalizedContext, nowMs);
  }

  /**
   * Clear failure cooldown state for a channel (failCount / lastFailAt /
   * cooldownUntil / consecutiveFailCount / cooldownLevel). Used by the proxy
   * recovery pass: after a burst of transient failures (403/429/5xx) the
   * last-success channel deserves one retry instead of being parked in
   * backoff for the full cooldown window.
   */
  async clearFailureCooldown(channelId: number): Promise<void> {
    const normalizedChannelId = Math.trunc(channelId || 0);
    if (normalizedChannelId <= 0) return;

    const channelRow = await db.select({
      routeId: schema.routeChannels.routeId,
      oauthRouteUnitId: schema.routeChannels.oauthRouteUnitId,
    }).from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, normalizedChannelId))
      .get();
    if (!channelRow) return;

    const clearedState = {
      failCount: 0,
      lastFailAt: null,
      cooldownUntil: null,
      consecutiveFailCount: 0,
      cooldownLevel: 0,
    };
    await db.update(schema.routeChannels).set(clearedState)
      .where(eq(schema.routeChannels.id, normalizedChannelId)).run();

    if (typeof channelRow.oauthRouteUnitId === 'number' && channelRow.oauthRouteUnitId > 0) {
      await db.update(schema.oauthRouteUnitMembers).set({
        ...clearedState,
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.oauthRouteUnitMembers.unitId, channelRow.oauthRouteUnitId)).run();
    }

    patchCachedChannel(normalizedChannelId, (channel) => {
      Object.assign(channel, clearedState);
    });
    invalidateRouteScopedCache(channelRow.routeId);
  }

  /**
   * Get all available models (aggregated from all routes).
   */
  async getAvailableModels(): Promise<string[]> {
    const routes = await loadEnabledRoutes();
    const exposed = buildVisibleEnabledRoutes(routes)
      .map((route) => getExposedModelNameForRoute(route).trim())
      .filter((name) => name.length > 0);
    return Array.from(new Set(exposed));
  }

  // --- Private methods ---


  private buildShadowCandidateInputs(
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs: number,
    connectivityLookup?: ConnectivityLookup | null,
    requestedModel?: string,
  ): ShadowCandidateInput[] {
    const resolveModelName = typeof modelName === 'function'
      ? modelName
      : (() => modelName);
    const historicalBySite = buildSiteHistoricalHealthMetrics(candidates);
    return candidates.map((candidate) => {
      const model = resolveModelName(candidate);
      const cost = resolveEffectiveUnitCost(candidate, model);
      const health = getSiteRuntimeHealthDetails(candidate.site.id, model, nowMs);
      const load = proxyChannelCoordinator.getChannelLoadSnapshot({
        channelId: candidate.channel.id,
        accountExtraConfig: candidate.account.extraConfig,
        accountOauthProvider: candidate.account.oauthProvider,
      });
      const historical = historicalBySite.get(candidate.site.id);
      const downstreamSiteMultiplier = downstreamPolicy.siteWeightMultipliers[candidate.site.id] ?? 1;
      const siteGlobalWeight = (
        Number.isFinite(candidate.site.globalWeight) && (candidate.site.globalWeight || 0) > 0
      ) ? (candidate.site.globalWeight as number) : 1;
      const balanceRaw = candidate.account.balance;
      const balance = typeof balanceRaw === 'number' && Number.isFinite(balanceRaw) ? balanceRaw : null;
      const credentialMode = getCredentialModeFromExtraConfig(candidate.account.extraConfig);
      const hasApiToken = typeof candidate.account.apiToken === 'string' && candidate.account.apiToken.trim().length > 0;
      const hasAccessToken = typeof candidate.account.accessToken === 'string' && candidate.account.accessToken.trim().length > 0;
      const lastBalanceRefresh = (candidate.account as { lastBalanceRefresh?: string | null }).lastBalanceRefresh;
      const balanceRefreshed = typeof lastBalanceRefresh === 'string' && lastBalanceRefresh.trim().length > 0;
      const looksLikeDirectApiKey = credentialMode === 'apikey' || (hasApiToken && !hasAccessToken);
      const credentialKind: 'apikey' | 'session' | 'unknown' = looksLikeDirectApiKey
        ? 'apikey'
        : (credentialMode === 'session' || hasAccessToken)
          ? 'session'
          : 'unknown';
      const balanceKnown = credentialKind === 'session' && balanceRefreshed;
      const connectivity: ConnectivitySignal = connectivityLookup
        ? resolveCandidateConnectivity(connectivityLookup, {
          accountId: candidate.account.id,
          tokenId: candidate.channel.tokenId,
          modelNames: [
            candidate.channel.sourceModel,
            model,
            requestedModel,
          ],
        })
        : null;
      return {
        channelId: candidate.channel.id,
        siteId: candidate.site.id,
        siteName: candidate.site.name,
        accountId: candidate.account.id,
        accountUsername: candidate.account.username,
        balance,
        balanceKnown,
        credentialKind,
        channelWeight: candidate.channel.weight ?? 10,
        successCount: candidate.channel.successCount ?? 0,
        failCount: candidate.channel.failCount ?? 0,
        unitCost: cost.unitCost,
        costSource: cost.source,
        runtimeHealth: health.combinedMultiplier,
        historicalHealth: historical?.multiplier ?? 1,
        recentSuccessRate: health.recentSampleCount > 0 ? health.recentSuccessRate : null,
        recentSampleCount: health.recentSampleCount,
        loadMultiplier: resolveChannelRuntimeLoadMultiplier(load),
        manualSiteWeight: siteGlobalWeight * (
          Number.isFinite(downstreamSiteMultiplier) && downstreamSiteMultiplier > 0
            ? downstreamSiteMultiplier
            : 1
        ),
        connectivity,
        protocolAffinity: siteProtocolAffinityFactor({
          protocolProfile: (candidate.site as { protocolProfile?: unknown }).protocolProfile,
          customHeaders: (candidate.site as { customHeaders?: unknown }).customHeaders,
        }),
      };
    });
  }

  /**
   * Live balanced-v2 selection (formerly shadow-only).
   * Default: stable top-1 pick. Small exploration rate keeps long-term discovery
   * without burning most primary hops on lower-ranked free/noisy candidates.
   */
  private selectByBalancedV2(
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs: number,
    requestedModel: string,
    connectivityLookup?: ConnectivityLookup | null,
  ): RouteChannelCandidate | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0] ?? null;
    try {
      const inputs = this.buildShadowCandidateInputs(
        candidates,
        modelName,
        downstreamPolicy,
        nowMs,
        connectivityLookup,
        requestedModel,
      );
      const ranked = rankShadowCandidates(inputs);
      const active = ranked.candidates.filter((c) => !c.factors.exclusion && c.score > 0 && c.probability > 0);
      let selectedId = ranked.selectedChannelId;
      // Probability-proportional selection with a bounded gap. Normal traffic
      // remains score-weighted, but a healthy low-probability candidate that has
      // reached ceil(1 / probability) calls since its last selection gets one
      // real request before weighted sampling resumes.
      if (active.length > 1) {
        const siteScores = new Map<number, number>();
        for (const row of active) {
          siteScores.set(row.siteId, (siteScores.get(row.siteId) ?? 0) + row.score);
        }
        const siteIds = [...siteScores.keys()];
        const bounded = selectWithBoundedGap(
          siteIds.map((siteId) => siteScores.get(siteId) ?? 0),
          siteIds.map((siteId) => getBoundedGapState(requestedModel, siteId)),
        );
        if (bounded) {
          const selectedSiteId = siteIds[bounded.selectedIndex];
          selectedId = active
            .filter((row) => row.siteId === selectedSiteId)
            .sort((left, right) => right.score - left.score)[0]?.channelId ?? selectedId;
          markBoundedGapStateDirty();
        }
      }
      const selected = candidates.find((c) => c.channel.id === selectedId) ?? candidates[0] ?? null;
      console.info(formatShadowSelectionLog({
        requestedModel,
        liveChannelId: selected?.channel.id ?? null,
        shadow: ranked,
      }));
      return selected;
    } catch (error) {
      console.warn(
        `[route-score] balanced-v2 failed, fallback first candidate: ${error instanceof Error ? error.message : String(error || 'unknown')}`,
      );
      return candidates[0] ?? null;
    }
  }

  private logShadowSelectionForCandidates(
    requestedModel: string,
    liveChannelId: number | null,
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs: number,
    connectivityLookup?: ConnectivityLookup | null,
  ): void {
    // Kept for non-weighted strategies (round_robin/stable_first) observability only.
    try {
      if (candidates.length === 0) return;
      const inputs = this.buildShadowCandidateInputs(
        candidates,
        modelName,
        downstreamPolicy,
        nowMs,
        connectivityLookup,
        requestedModel,
      );
      const shadow = rankShadowCandidates(inputs);
      console.info(formatShadowSelectionLog({
        requestedModel,
        liveChannelId,
        shadow,
      }));
    } catch (error) {
      console.warn(
        `[route-shadow] failed: ${error instanceof Error ? error.message : String(error || 'unknown')}`,
      );
    }
  }

  private async selectFromMatch(
    match: RouteMatch,
    requestedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy,
    excludeChannelIds: number[] = [],
    recordSelection = true,
  ): Promise<SelectedChannel | null> {
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const bypassSourceModelCheck = requestedByDisplayName;
    const routeStrategy = resolveRouteStrategy(match.route);
    const runtimeModelResolver = requestedByDisplayName
      ? ((candidate: RouteChannelCandidate) => normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
      : mappedModel;

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const available = match.channels.filter((candidate) => (
      this.getCandidateEligibilityReasons(candidate, {
        requestedModel,
        bypassSourceModelCheck,
        excludeChannelIds,
        nowIso,
        downstreamPolicy,
      }).length === 0
    ));

    if (available.length === 0) return null;

    const connectivityLookup = await loadConnectivityLookup(
      available.map((candidate) => candidate.account.id),
      available
        .map((candidate) => candidate.channel.tokenId)
        .filter((tokenId): tokenId is number => typeof tokenId === 'number' && tokenId > 0),
      nowMs,
    );
    const connectivityResolve = (candidate: RouteChannelCandidate): ConnectivitySignal => (
      resolveCandidateConnectivity(connectivityLookup, {
        accountId: candidate.account.id,
        tokenId: candidate.channel.tokenId,
        modelNames: [
          candidate.channel.sourceModel,
          typeof runtimeModelResolver === 'function'
            ? runtimeModelResolver(candidate)
            : runtimeModelResolver,
          requestedModel,
          mappedModel,
        ],
      })
    );
    const connectivityFiltered = softAvoidDisconnectedCandidates(available, connectivityResolve);
    const routePool = connectivityFiltered.candidates;

    if (routeStrategy === 'round_robin') {
      const layers = new Map<number, RouteChannelCandidate[]>();
      for (const candidate of routePool) {
        const priority = candidate.channel.priority ?? 0;
        if (!layers.has(priority)) layers.set(priority, []);
        layers.get(priority)!.push(candidate);
      }
      const sortedPriorities = [...layers.keys()].sort((left, right) => left - right);
      for (const [layerIndex, priority] of sortedPriorities.entries()) {
        const rawLayer = layers.get(priority) ?? [];
        const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawLayer, runtimeModelResolver, nowMs);
        const hasFreshCandidate = breakerFiltered.candidates.some(
          (candidate) => !isChannelRecentlyFailed(candidate.channel, nowMs),
        );
        if (!hasFreshCandidate && layerIndex < sortedPriorities.length - 1) continue;
        const candidates = filterRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
        const selected = this.selectRoundRobinCandidate(candidates);
        if (!selected) continue;
        const resolvedRoundRobin = await this.finalizeSelectedCandidateForDispatch(
          selected,
          match,
          requestedModel,
          mappedModel,
          downstreamPolicy,
          recordSelection,
          nowIso,
          nowMs,
          undefined,
          undefined,
          false,
          excludeChannelIds,
        );
        if (!resolvedRoundRobin) continue;
        this.logShadowSelectionForCandidates(
          requestedModel,
          resolvedRoundRobin.channel.id,
          candidates,
          runtimeModelResolver,
          downstreamPolicy,
          nowMs,
          connectivityLookup,
        );
        return resolvedRoundRobin;
      }
      return null;
    }

    if (routeStrategy === 'stable_first') {
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(routePool, runtimeModelResolver, nowMs);
      const candidates = filterRecentlyFailedCandidates(breakerFiltered.candidates, nowMs);
      const rotationKey = this.buildStableFirstRotationKey(match.route.id, requestedModel);
      const poolPlan = buildStableFirstPoolPlan(
        candidates,
        requestedByDisplayName ? runtimeModelResolver : mappedModel,
        nowMs,
      );
      const shouldUseObservation = (
        poolPlan.observationCandidates.length > 0
        && (
          poolPlan.primaryCandidates.length <= 0
          || (
            recordSelection
            && shouldUseStableFirstObservationCandidate(rotationKey, poolPlan.observationCandidates, nowMs)
          )
        )
      );
      const selectionPool = shouldUseObservation
        ? poolPlan.observationCandidates
        : (poolPlan.primaryCandidates.length > 0 ? poolPlan.primaryCandidates : poolPlan.observationCandidates);
      const selected = this.stableFirstSelect(
        selectionPool,
        requestedByDisplayName ? runtimeModelResolver : mappedModel,
        downstreamPolicy,
        nowMs,
        shouldUseObservation ? `${rotationKey}:observe` : rotationKey,
      );
      if (!selected) return null;
      const resolvedStable = await this.finalizeSelectedCandidateForDispatch(
        selected,
        match,
        requestedModel,
        mappedModel,
        downstreamPolicy,
        recordSelection,
        nowIso,
        nowMs,
        rotationKey,
        `${rotationKey}:observe`,
        shouldUseObservation,
        excludeChannelIds,
      );
      if (resolvedStable) {
        this.logShadowSelectionForCandidates(
          requestedModel,
          resolvedStable.channel.id,
          selectionPool,
          requestedByDisplayName ? runtimeModelResolver : mappedModel,
          downstreamPolicy,
          nowMs,
          connectivityLookup,
        );
      }
      return resolvedStable;
    }

    const layers = new Map<number, typeof routePool>();
    for (const candidate of routePool) {
      const priority = candidate.channel.priority ?? 0;
      if (!layers.has(priority)) layers.set(priority, []);
      layers.get(priority)!.push(candidate);
    }

    const sortedPriorities = Array.from(layers.keys()).sort((a, b) => a - b);
    for (const [layerIndex, priority] of sortedPriorities.entries()) {
      const rawLayer = layers.get(priority) ?? [];
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawLayer, runtimeModelResolver, nowMs);
      const layerCandidates = breakerFiltered.candidates;
      const hasFreshCandidate = layerCandidates.some(
        (candidate) => !isChannelRecentlyFailed(candidate.channel, nowMs),
      );
      // A fully cooling-down layer must not block lower-priority layers: the
      // fallback in filterRecentlyFailedCandidates would otherwise return the
      // whole pool and weightedRandomSelect would burn a hop on a channel that
      // just failed. Only the last layer keeps the least-bad fallback when
      // nothing fresh exists anywhere in the route.
      if (layerCandidates.length > 0
        && !hasFreshCandidate
        && layerIndex < sortedPriorities.length - 1) {
        continue;
      }
      const candidates = filterRecentlyFailedCandidates(layerCandidates, nowMs);
      const selected = this.weightedRandomSelect(
        candidates,
        requestedByDisplayName ? runtimeModelResolver : mappedModel,
        downstreamPolicy,
        nowMs,
        requestedModel,
        connectivityLookup,
      );
      if (!selected) continue;
      const resolved = await this.finalizeSelectedCandidateForDispatch(
        selected,
        match,
        requestedModel,
        mappedModel,
        downstreamPolicy,
        recordSelection,
        nowIso,
        nowMs,
        undefined,
        undefined,
        false,
        excludeChannelIds,
      );
      if (resolved) return resolved;
    }

    return null;
  }

  private async selectPreferredFromMatch(
    match: RouteMatch,
    requestedModel: string,
    preferredChannelId: number,
    downstreamPolicy: DownstreamRoutingPolicy,
    excludeChannelIds: number[] = [],
    recordSelection = true,
    options?: PreferredChannelSelectionOptions,
  ): Promise<SelectedChannel | null> {
    const mappedModel = resolveMappedModel(requestedModel, match.route.modelMapping);
    const requestedByDisplayName = isRouteDisplayNameMatch(requestedModel, match.route.displayName);
    const bypassSourceModelCheck = requestedByDisplayName;
    const routeStrategy = resolveRouteStrategy(match.route);
    const runtimeModelResolver = requestedByDisplayName
      ? ((candidate: RouteChannelCandidate) => normalizeChannelSourceModel(candidate.channel.sourceModel) || mappedModel)
      : mappedModel;

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const available = match.channels.filter((candidate) => (
      this.getCandidateEligibilityReasons(candidate, {
        requestedModel,
        bypassSourceModelCheck,
        excludeChannelIds,
        nowIso,
        downstreamPolicy,
      }).length === 0
    ));

    const preferred = available.find((candidate) => candidate.channel.id === preferredChannelId);
    if (!preferred) return null;

    // Sticky/last-success hops skip balanced-v2 scoring, so a session account
    // near exhaustion must be yielded before it gets drained by dense same-key
    // traffic (forced single-shot path stays unaffected).
    if (options?.yieldOnLowBalance) {
      const preferredModel = typeof runtimeModelResolver === 'function'
        ? runtimeModelResolver(preferred)
        : runtimeModelResolver;
      const coverage = resolvePreferredBalanceCoverage(preferred, preferredModel);
      if (coverage !== null && coverage < STICKY_PREFERRED_YIELD_LOW_COVERAGE) {
        return null;
      }
    }

    // Sticky/forced may pin a recently failed connectivity path. Soft-break stickiness
    // when other eligible candidates are not known-false (forced path is still single-shot).
    try {
      const connectivityLookup = await loadConnectivityLookup(
        available.map((candidate) => candidate.account.id),
        available
          .map((candidate) => candidate.channel.tokenId)
          .filter((tokenId): tokenId is number => typeof tokenId === 'number' && tokenId > 0),
        nowMs,
      );
      const resolveConn = (candidate: RouteChannelCandidate): ConnectivitySignal => (
        resolveCandidateConnectivity(connectivityLookup, {
          accountId: candidate.account.id,
          tokenId: candidate.channel.tokenId,
          modelNames: [
            candidate.channel.sourceModel,
            typeof runtimeModelResolver === 'function'
              ? runtimeModelResolver(candidate)
              : runtimeModelResolver,
            requestedModel,
            mappedModel,
          ],
        })
      );
      const preferredConn = resolveConn(preferred);
      if (preferredConn === false) {
        const hasHealthyAlt = available.some((candidate) => {
          if (candidate.channel.id === preferred.channel.id) return false;
          return resolveConn(candidate) !== false;
        });
        if (hasHealthyAlt) return null;
      }
    } catch {
      // never block preferred selection on lookup failure
    }

    const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel([preferred], runtimeModelResolver, nowMs);
    if (breakerFiltered.candidates.length <= 0) return null;

    const selected = breakerFiltered.candidates.find((candidate) => candidate.channel.id === preferredChannelId);
    if (!selected) return null;
    if (!isOauthRouteUnitCandidate(selected) && routeStrategy !== 'round_robin' && isChannelRecentlyFailed(selected.channel, nowMs)) {
      return null;
    }
    return await this.finalizeSelectedCandidateForDispatch(
      selected,
      match,
      requestedModel,
      mappedModel,
      downstreamPolicy,
      recordSelection && (routeStrategy === 'round_robin' || routeStrategy === 'stable_first'),
      nowIso,
      nowMs,
      routeStrategy === 'stable_first' ? this.buildStableFirstRotationKey(match.route.id, requestedModel) : undefined,
      routeStrategy === 'stable_first' ? `${this.buildStableFirstRotationKey(match.route.id, requestedModel)}:observe` : undefined,
      false,
      excludeChannelIds,
    );
  }

  private async findRoute(model: string, downstreamPolicy: DownstreamRoutingPolicy): Promise<RouteMatch | null> {
    let routes = await loadEnabledRoutes();

    const supportedPatterns = Array.isArray(downstreamPolicy.supportedModels)
      ? downstreamPolicy.supportedModels
      : [];
    const matchedSupportedPattern = supportedPatterns.some((pattern) => matchesModelPattern(model, pattern));

    if (downstreamPolicy.allowedRouteIds.length > 0 && !matchedSupportedPattern) {
      const allowSet = new Set(downstreamPolicy.allowedRouteIds);
      routes = routes.filter((route) => allowSet.has(route.id));
    }

    const matchedRoute = routes.find((route) => isExplicitGroupRoute(route) && isRouteDisplayNameMatch(model, route.displayName))
      || routes.find((route) => (
        !isExplicitGroupRoute(route)
        && isExactRouteModelPattern(route.modelPattern)
        && (route.modelPattern || '').trim() === model
      ))
      || routes.find((route) => !isExplicitGroupRoute(route) && isRouteDisplayNameMatch(model, route.displayName))
      || routes.find((route) => !isExplicitGroupRoute(route) && matchesModelPattern(model, route.modelPattern));

    if (!matchedRoute) return null;

    return await this.loadRouteMatch(matchedRoute);
  }

  private async findRouteById(routeId: number, downstreamPolicy: DownstreamRoutingPolicy): Promise<RouteMatch | null> {
    if (downstreamPolicy.allowedRouteIds.length > 0 && !downstreamPolicy.allowedRouteIds.includes(routeId)) {
      return null;
    }

    const route = (await loadEnabledRoutes()).find((item) => item.id === routeId);
    if (!route) return null;

    return await this.loadRouteMatch(route);
  }

  private async loadRouteMatch(route: RouteRow): Promise<RouteMatch> {
    return await loadRouteMatch(route);
  }

  private resolveRouteUnitMemberTokenValue(candidate: {
    account: typeof schema.accounts.$inferSelect;
  }): string | null {
    const oauthAccessToken = candidate.account.accessToken?.trim();
    if (oauthAccessToken) return oauthAccessToken;
    const apiToken = candidate.account.apiToken?.trim();
    return apiToken || null;
  }

  private buildRouteUnitMemberDispatchCandidate(
    outerCandidate: RouteChannelCandidate,
    memberCandidate: RouteChannelCandidate['routeUnitMembers'][number],
  ): RouteChannelCandidate {
    return {
      ...outerCandidate,
      account: memberCandidate.account,
      site: memberCandidate.site,
      token: null,
    };
  }

  private getRouteUnitMemberEligibilityReasons(
    outerCandidate: RouteChannelCandidate,
    memberCandidate: RouteChannelCandidate['routeUnitMembers'][number],
    options: CandidateEligibilityOptions,
  ): string[] {
    const reasonParts: string[] = [];
    const bypassSourceModelCheck = options.bypassSourceModelCheck ?? false;
    const nowIso = options.nowIso ?? new Date().toISOString();

    if (!bypassSourceModelCheck && !channelSupportsRequestedModel(outerCandidate.channel.sourceModel, options.requestedModel)) {
      reasonParts.push(`来源模型不匹配=${outerCandidate.channel.sourceModel || ''}`);
    }

    if (!outerCandidate.channel.enabled) reasonParts.push('通道禁用');

    if (memberCandidate.account.status !== 'active') {
      reasonParts.push(`账号状态=${memberCandidate.account.status}`);
    }

    if (isSiteDisabled(memberCandidate.site.status)) {
      reasonParts.push(`站点状态=${memberCandidate.site.status || 'disabled'}`);
    }

    const downstreamExclusionReason = this.resolveDownstreamExclusionReason(
      this.buildRouteUnitMemberDispatchCandidate(outerCandidate, memberCandidate),
      options.downstreamPolicy,
    );
    if (downstreamExclusionReason) {
      reasonParts.push(downstreamExclusionReason);
    }

    const tokenValue = this.resolveRouteUnitMemberTokenValue(memberCandidate);
    if (!tokenValue) reasonParts.push('令牌不可用');

    if (isOauthRouteUnitMemberCoolingDown(memberCandidate.member, nowIso)) {
      reasonParts.push('冷却中');
    }

    return reasonParts;
  }

  private getEligibleRouteUnitMembers(
    candidate: RouteChannelCandidate,
    options: CandidateEligibilityOptions,
  ): RouteChannelCandidate['routeUnitMembers'] {
    if (!isOauthRouteUnitCandidate(candidate)) return [];
    return candidate.routeUnitMembers.filter((memberCandidate) => (
      this.getRouteUnitMemberEligibilityReasons(candidate, memberCandidate, options).length === 0
    ));
  }

  private getRoundRobinRouteUnitMembers(
    members: RouteChannelCandidate['routeUnitMembers'],
  ): RouteChannelCandidate['routeUnitMembers'] {
    return [...members].sort((left, right) => {
      const selectionOrder = compareNullableTimeAsc(
        left.member.lastSelectedAt || left.member.lastUsedAt,
        right.member.lastSelectedAt || right.member.lastUsedAt,
      );
      if (selectionOrder !== 0) return selectionOrder;

      const usedOrder = compareNullableTimeAsc(left.member.lastUsedAt, right.member.lastUsedAt);
      if (usedOrder !== 0) return usedOrder;

      const sortOrder = (left.member.sortOrder ?? 0) - (right.member.sortOrder ?? 0);
      if (sortOrder !== 0) return sortOrder;

      return left.account.id - right.account.id;
    });
  }

  private getStickyPreferredRouteUnitMember(
    members: RouteChannelCandidate['routeUnitMembers'],
  ): RouteChannelCandidate['routeUnitMembers'][number] | null {
    return [...members].sort((left, right) => {
      const selectionOrder = compareNullableTimeDesc(
        left.member.lastSelectedAt || left.member.lastUsedAt,
        right.member.lastSelectedAt || right.member.lastUsedAt,
      );
      if (selectionOrder !== 0) return selectionOrder;

      const sortOrder = (left.member.sortOrder ?? 0) - (right.member.sortOrder ?? 0);
      if (sortOrder !== 0) return sortOrder;

      return left.account.id - right.account.id;
    })[0] ?? null;
  }

  private selectRouteUnitMember(
    candidate: RouteChannelCandidate,
    requestedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy,
    nowIso: string,
    nowMs: number,
    excludeChannelIds: number[] = [],
  ): RouteChannelCandidate['routeUnitMembers'][number] | null {
    if (!isOauthRouteUnitCandidate(candidate)) return null;
    const eligibleMembers = this.getEligibleRouteUnitMembers(candidate, {
      requestedModel,
      bypassSourceModelCheck: true,
      excludeChannelIds: [],
      nowIso,
      downstreamPolicy,
    });
    if (eligibleMembers.length === 0) return null;

    const isRouteUnitFailover = excludeChannelIds.includes(candidate.channel.id);
    const healthyMembers = isRouteUnitFailover
      ? eligibleMembers.filter((memberCandidate) => !isChannelRecentlyFailed(memberCandidate.member, nowMs))
      : filterRecentlyFailedCandidates(
        eligibleMembers.map((memberCandidate) => ({
          memberCandidate,
          channel: memberCandidate.member,
        })),
        nowMs,
      ).map((item) => item.memberCandidate);
    const candidateMembers = healthyMembers.length > 0
      ? healthyMembers
      : (isRouteUnitFailover ? [] : eligibleMembers);
    if (candidate.routeUnit?.strategy === 'stick_until_unavailable') {
      const sticky = this.getStickyPreferredRouteUnitMember(candidateMembers);
      if (sticky) return sticky;
      return this.getRoundRobinRouteUnitMembers(candidateMembers)[0] ?? null;
    }

    return this.getRoundRobinRouteUnitMembers(candidateMembers)[0] ?? null;
  }

  private async recordRouteUnitMemberSelection(
    routeUnitId: number,
    accountId: number,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    await db.update(schema.oauthRouteUnitMembers).set({
      lastSelectedAt: nowIso,
      updatedAt: nowIso,
    }).where(and(
      eq(schema.oauthRouteUnitMembers.unitId, routeUnitId),
      eq(schema.oauthRouteUnitMembers.accountId, accountId),
    )).run();
    const routeRows = await db.select({
      routeId: schema.routeChannels.routeId,
    }).from(schema.routeChannels)
      .where(eq(schema.routeChannels.oauthRouteUnitId, routeUnitId))
      .all();
    const routeIds: number[] = Array.from(new Set<number>(
      routeRows
        .map((row: any) => Number(row.routeId))
        .filter((routeId: any): routeId is number => Number.isFinite(routeId) && routeId > 0),
    ));
    for (const routeId of routeIds) {
      invalidateRouteScopedCache(routeId);
    }
  }

  private resolveChannelTokenValue(candidate: {
    channel: typeof schema.routeChannels.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    site?: typeof schema.sites.$inferSelect | null;
    token: typeof schema.accountTokens.$inferSelect | null;
  }): string | null {
    if (candidate.channel.tokenId) {
      if (!candidate.token) return null;
      if (!isUsableAccountToken(candidate.token)) return null;
      const token = candidate.token.token?.trim();
      return token ? token : null;
    }

    if (getOauthInfoFromAccount(candidate.account)) {
      const accessToken = candidate.account.accessToken?.trim();
      if (accessToken) return accessToken;
      return null;
    }

    const fallback = candidate.account.apiToken?.trim();
    if (fallback) return fallback;

    return null;
  }

  private resolveDownstreamExclusionReason(
    candidate: RouteChannelCandidate,
    downstreamPolicy?: DownstreamRoutingPolicy,
  ): string | null {
    if (!downstreamPolicy) return null;

    const excludedSiteIds = Array.isArray(downstreamPolicy.excludedSiteIds)
      ? downstreamPolicy.excludedSiteIds
      : [];
    if (excludedSiteIds.includes(candidate.site.id)) {
      return '站点已被下游密钥排除';
    }

    const excludedCredentialRefs = Array.isArray(downstreamPolicy.excludedCredentialRefs)
      ? downstreamPolicy.excludedCredentialRefs
      : [];
    if (excludedCredentialRefs.length <= 0) {
      return null;
    }

    for (const ref of excludedCredentialRefs) {
      if (ref.kind === 'account_token') {
        if (
          candidate.channel.tokenId === ref.tokenId
          && candidate.token?.id === ref.tokenId
          && candidate.account.id === ref.accountId
          && candidate.site.id === ref.siteId
        ) {
          return 'API Key/令牌已被下游密钥排除';
        }
        continue;
      }

      if (
        candidate.channel.tokenId == null
        && candidate.account.id === ref.accountId
        && candidate.site.id === ref.siteId
      ) {
        const resolvedTokenValue = this.resolveChannelTokenValue(candidate);
        const accountApiToken = candidate.account.apiToken?.trim() || '';
        if (resolvedTokenValue && accountApiToken && resolvedTokenValue === accountApiToken) {
          return 'API Key/令牌已被下游密钥排除';
        }
      }
    }

    return null;
  }

  private getCandidateEligibilityReasons(
    candidate: RouteChannelCandidate,
    options: CandidateEligibilityOptions,
  ): CandidateEligibilityReason[] {
    const reasons: CandidateEligibilityReason[] = [];
    const addReason = (
      code: RouteDecisionReasonCode,
      message: string,
      details?: Record<string, unknown>,
    ) => reasons.push({ code, message, details });
    const bypassSourceModelCheck = options.bypassSourceModelCheck ?? false;
    const excludeChannelIds = options.excludeChannelIds ?? [];
    const nowIso = options.nowIso ?? new Date().toISOString();

    if (!bypassSourceModelCheck && !channelSupportsRequestedModel(candidate.channel.sourceModel, options.requestedModel)) {
      addReason('source_model_mismatch', `来源模型不匹配=${candidate.channel.sourceModel || ''}`, {
        sourceModel: candidate.channel.sourceModel || null,
        requestedModel: options.requestedModel,
      });
    }

    if (!candidate.channel.enabled) addReason('channel_disabled', '通道禁用');

    if (isOauthRouteUnitCandidate(candidate)) {
      if (excludeChannelIds.includes(candidate.channel.id)) {
        // Route-unit failover should stay inside the same outer channel and switch members instead of
        // excluding the entire pool after one member fails.
      }

      if (this.getEligibleRouteUnitMembers(candidate, options).length === 0) {
        addReason(
          'route_unit_unavailable',
          `路由池成员不可用（${candidate.routeUnit?.name || getOauthRouteUnitStrategyLabel(candidate.routeUnit?.strategy || 'round_robin')}）`,
          { routeUnitId: candidate.routeUnit?.id ?? null },
        );
      }
      return reasons;
    }

    if (isExplicitTokenChannel(candidate)) {
      if (candidate.account.status === 'disabled') {
        addReason('account_unavailable', `账号状态=${candidate.account.status}`, { status: candidate.account.status });
      }
    } else if (candidate.account.status !== 'active') {
      addReason('account_unavailable', `账号状态=${candidate.account.status}`, { status: candidate.account.status });
    }

    if (isSiteDisabled(candidate.site.status)) {
      addReason('site_disabled', `站点状态=${candidate.site.status || 'disabled'}`, {
        status: candidate.site.status || 'disabled',
      });
    }

    const downstreamExclusionReason = this.resolveDownstreamExclusionReason(candidate, options.downstreamPolicy);
    if (downstreamExclusionReason) {
      addReason('downstream_excluded', downstreamExclusionReason);
    }

    if (excludeChannelIds.includes(candidate.channel.id)) {
      addReason('already_attempted', '当前请求已尝试');
    }

    const tokenValue = this.resolveChannelTokenValue(candidate);
    if (!tokenValue) addReason('token_unavailable', '令牌不可用');

    if (candidate.channel.cooldownUntil && candidate.channel.cooldownUntil > nowIso) {
      addReason('channel_cooldown', '冷却中', { cooldownUntil: candidate.channel.cooldownUntil });
    }

    return reasons;
  }

  private getRoundRobinCandidates(candidates: RouteChannelCandidate[]): RouteChannelCandidate[] {
    return [...candidates].sort((left, right) => {
      const selectionOrder = compareNullableTimeAsc(
        left.channel.lastSelectedAt || left.channel.lastUsedAt,
        right.channel.lastSelectedAt || right.channel.lastUsedAt,
      );
      if (selectionOrder !== 0) return selectionOrder;

      const usedOrder = compareNullableTimeAsc(left.channel.lastUsedAt, right.channel.lastUsedAt);
      if (usedOrder !== 0) return usedOrder;

      return (left.channel.id ?? 0) - (right.channel.id ?? 0);
    });
  }

  private selectRoundRobinCandidate(candidates: RouteChannelCandidate[]): RouteChannelCandidate | null {
    return this.getRoundRobinCandidates(candidates)[0] ?? null;
  }

  private compareStableFirstCandidates(left: RouteChannelCandidate, right: RouteChannelCandidate): number {
    return compareStableFirstCandidateOrder(left, right);
  }

  private buildStableFirstRotationKey(routeId: number, requestedModel: string): string {
    const normalizedModel = normalizeModelAlias(requestedModel)
      || normalizeRouteDisplayName(requestedModel).toLowerCase()
      || String(routeId);
    return `${routeId}:${normalizedModel}`;
  }

  private getStableFirstSiteOrder(candidates: RouteChannelCandidate[], siteId: number): number {
    let order = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate.site.id !== siteId) continue;
      order = Math.min(order, candidate.channel.priority ?? 0);
    }
    return Number.isFinite(order) ? order : 0;
  }

  private getStableFirstOrderedSiteLeaderIndices(
    candidates: RouteChannelCandidate[],
    stableSiteLeaderIndices: number[],
  ): number[] {
    return [...stableSiteLeaderIndices].sort((leftIndex, rightIndex) => {
      const leftSiteId = candidates[leftIndex]?.site.id ?? 0;
      const rightSiteId = candidates[rightIndex]?.site.id ?? 0;
      const orderDiff = this.getStableFirstSiteOrder(candidates, leftSiteId)
        - this.getStableFirstSiteOrder(candidates, rightSiteId);
      if (orderDiff !== 0) return orderDiff;
      return (candidates[leftIndex]?.channel.id ?? 0) - (candidates[rightIndex]?.channel.id ?? 0);
    });
  }

  private async recordChannelSelection(channelId: number): Promise<void> {
    const nowIso = new Date().toISOString();
    await db.update(schema.routeChannels).set({
      lastSelectedAt: nowIso,
    }).where(eq(schema.routeChannels.id, channelId)).run();

    patchCachedChannel(channelId, (channel) => {
      channel.lastSelectedAt = nowIso;
    });
  }

  private async finalizeSelectedCandidateForDispatch(
    selected: RouteChannelCandidate,
    match: RouteMatch,
    requestedModel: string,
    _mappedModel: string,
    downstreamPolicy: DownstreamRoutingPolicy,
    recordSelection: boolean,
    nowIso: string,
    nowMs: number,
    stableFirstRotationKey?: string,
    stableFirstObservationKey?: string,
    usedObservation = false,
    excludeChannelIds: number[] = [],
  ): Promise<SelectedChannel | null> {
    let dispatchCandidate = selected;
    let resolvedRouteUnitMemberTokenValue: string | null = null;
    if (isOauthRouteUnitCandidate(selected)) {
      const member = this.selectRouteUnitMember(
        selected,
        requestedModel,
        downstreamPolicy,
        nowIso,
        nowMs,
        excludeChannelIds,
      );
      if (!member || !selected.routeUnit) return null;
      resolvedRouteUnitMemberTokenValue = this.resolveRouteUnitMemberTokenValue(member);
      dispatchCandidate = this.buildRouteUnitMemberDispatchCandidate(selected, member);
      if (recordSelection) {
        await this.recordRouteUnitMemberSelection(selected.routeUnit.id, member.account.id);
      }
    }

    const tokenValue = resolvedRouteUnitMemberTokenValue ?? this.resolveChannelTokenValue(dispatchCandidate);
    if (!tokenValue) return null;

    if (recordSelection) {
      if (stableFirstRotationKey && stableFirstObservationKey) {
        rememberStableFirstSiteSelectionForKey(
          usedObservation ? stableFirstObservationKey : stableFirstRotationKey,
          dispatchCandidate.site.id,
        );
        updateStableFirstObservationProgress(stableFirstRotationKey, {
          usedObservation,
          selectedSiteId: dispatchCandidate.site.id,
          nowMs,
        });
      }
      await this.recordChannelSelection(selected.channel.id);
    }

    const modelResolution = resolveModelResolution({
      requestedModel,
      route: match.route,
      modelMapping: match.route.modelMapping,
      channelSourceModel: selected.channel.sourceModel,
    });
    const actualModel = modelResolution.upstreamModel;

    return {
      ...dispatchCandidate,
      channel: selected.channel,
      tokenValue,
      tokenName: dispatchCandidate.token?.name || 'default',
      actualModel,
    };
  }

  private weightedRandomSelect(
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs = Date.now(),
    requestedModel = '',
    connectivityLookup?: ConnectivityLookup | null,
  ) {
    // Production selection now uses balanced-v2 (API-key boost + soft balance drain + connectivity).
    return this.selectByBalancedV2(
      candidates,
      modelName,
      downstreamPolicy,
      nowMs,
      requestedModel || (typeof modelName === 'string' ? modelName : ''),
      connectivityLookup,
    );
  }

  private stableFirstSelect(
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs = Date.now(),
    stableFirstRotationKey?: string,
  ) {
    return this.calculateWeightedSelection(
      candidates,
      modelName,
      downstreamPolicy,
      nowMs,
      'stable_first',
      stableFirstRotationKey,
    ).selected;
  }

  private calculateWeightedSelection(
    candidates: RouteChannelCandidate[],
    modelName: string | ((candidate: RouteChannelCandidate) => string),
    downstreamPolicy: DownstreamRoutingPolicy,
    nowMs = Date.now(),
    selectionMode: WeightedSelectionMode = 'weighted',
    stableFirstRotationKey?: string,
  ): WeightedSelectionResult {
    if (candidates.length === 0) {
      return {
        selected: null as RouteChannelCandidate | null,
        details: [] as Array<{ candidate: RouteChannelCandidate; probability: number; reason: string }>,
        stableSiteCount: 0,
      };
    }

    const { baseWeightFactor, valueScoreFactor, costWeight, balanceWeight, usageWeight } = config.routingWeights;
    const resolveModelName = typeof modelName === 'function'
      ? modelName
      : (() => modelName);
    const effectiveCosts = candidates.map((candidate) => resolveEffectiveUnitCost(candidate, resolveModelName(candidate)));
    const runtimeHealthDetails = candidates.map((candidate) => (
      getSiteRuntimeHealthDetails(candidate.site.id, resolveModelName(candidate), nowMs)
    ));
    const channelLoadSnapshots = candidates.map((candidate) => (
      proxyChannelCoordinator.getChannelLoadSnapshot({
        channelId: candidate.channel.id,
        accountExtraConfig: candidate.account.extraConfig,
        accountOauthProvider: candidate.account.oauthProvider,
      })
    ));

    const valueScores = candidates.map((c, i) => {
      const unitCost = effectiveCosts[i]?.unitCost || 1;
      const balance = c.account.balance || 0;
      const totalUsed = (c.channel.successCount ?? 0) + (c.channel.failCount ?? 0);
      const recentUsage = Math.max(totalUsed, 1);
      return costWeight * (1 / unitCost) + balanceWeight * balance + usageWeight * (1 / recentUsage);
    });

    const normalizedVS = normalizeValueScores(valueScores);

    const baseContributions = candidates.map((c, i) => {
      const weight = c.channel.weight ?? 10;
      return (weight + 10) * (baseWeightFactor + normalizedVS[i] * valueScoreFactor);
    });

    // Avoid over-favoring a site that has many tokens/channels for the same route.
    // Site-level total contribution remains comparable, then split across its channels.
    const siteChannelCounts = countCandidatesBySite(candidates.map((candidate) => candidate.site.id));
    const siteHistoricalHealthMetrics = buildSiteHistoricalHealthMetrics(candidates);

    const contributions = candidates.map((candidate, i) => {
      const siteChannels = Math.max(1, siteChannelCounts.get(candidate.site.id) || 1);
      const runtimeMultiplier = runtimeHealthDetails[i]?.combinedMultiplier ?? 1;
      const runtimeLoadMultiplier = resolveChannelRuntimeLoadMultiplier(channelLoadSnapshots[i]);
      if (selectionMode === 'stable_first') {
        const recentSuccessRate = resolveStableFirstSuccessRate(
          runtimeHealthDetails[i],
          siteHistoricalHealthMetrics.get(candidate.site.id)?.successRate,
        );
        let contribution = Math.max(1e-4, recentSuccessRate ** 2);
        contribution *= runtimeMultiplier;
        contribution *= runtimeLoadMultiplier;
        return contribution / siteChannels;
      }

      let contribution = baseContributions[i] / siteChannels;
      const downstreamSiteMultiplier = downstreamPolicy.siteWeightMultipliers[candidate.site.id] ?? 1;
      const normalizedDownstreamSiteMultiplier =
        (Number.isFinite(downstreamSiteMultiplier) && downstreamSiteMultiplier > 0)
          ? downstreamSiteMultiplier
          : 1;
      const siteGlobalWeight =
        (Number.isFinite(candidate.site.globalWeight) && (candidate.site.globalWeight || 0) > 0)
          ? (candidate.site.globalWeight as number)
          : 1;
      const combinedSiteWeight = siteGlobalWeight * normalizedDownstreamSiteMultiplier;
      if (combinedSiteWeight > 0 && Number.isFinite(combinedSiteWeight)) {
        contribution *= combinedSiteWeight;
      }

      contribution *= runtimeMultiplier;
      contribution *= siteHistoricalHealthMetrics.get(candidate.site.id)?.multiplier ?? 1;
      contribution *= runtimeLoadMultiplier;

      // If upstream price is unknown and we are using fallback unit cost,
      // apply an explicit penalty so raising fallback cost meaningfully lowers probability.
      if (effectiveCosts[i]?.source === 'fallback') {
        contribution *= 1 / Math.max(1, effectiveCosts[i]?.unitCost || 1);
      }

      return contribution;
    });

    const probabilities = normalizeContributions(contributions);
    const rankedIndices = rankContributionIndices(
      contributions,
      (leftIndex, rightIndex) => this.compareStableFirstCandidates(
        candidates[leftIndex],
        candidates[rightIndex],
      ),
    );
    const rankByIndex = buildContributionRanks(rankedIndices);
    const stableSiteLeaderIndices = selectionMode === 'stable_first'
      ? this.getStableFirstSiteLeaderIndices(candidates, contributions, rankedIndices)
      : [];
    const stableSiteIds = new Set(stableSiteLeaderIndices.map((index) => candidates[index]?.site.id).filter((siteId) => typeof siteId === 'number'));
    const details = candidates.map((candidate, i) => {
      const probability = probabilities[i] ?? 0;
      const weight = candidate.channel.weight ?? 10;
      const cost = effectiveCosts[i];
      const costSourceText = cost?.source === 'observed'
        ? '实测'
        : (cost?.source === 'configured' ? '配置' : (cost?.source === 'catalog' ? '目录' : '默认'));
      const siteChannels = Math.max(1, siteChannelCounts.get(candidate.site.id) || 1);
      const downstreamSiteMultiplier = downstreamPolicy.siteWeightMultipliers[candidate.site.id] ?? 1;
      const normalizedDownstreamSiteMultiplier =
        (Number.isFinite(downstreamSiteMultiplier) && downstreamSiteMultiplier > 0)
          ? downstreamSiteMultiplier
          : 1;
      const siteGlobalWeight =
        (Number.isFinite(candidate.site.globalWeight) && (candidate.site.globalWeight || 0) > 0)
          ? (candidate.site.globalWeight as number)
          : 1;
      const combinedSiteWeight = siteGlobalWeight * normalizedDownstreamSiteMultiplier;
      const siteRuntimeDetail = runtimeHealthDetails[i];
      const siteHistoricalHealth = siteHistoricalHealthMetrics.get(candidate.site.id);
      const siteHistoricalMultiplier = siteHistoricalHealth?.multiplier ?? 1;
      const historicalSuccessRateText = siteHistoricalHealth?.successRate == null
        ? '—'
        : `${(siteHistoricalHealth.successRate * 100).toFixed(1)}%`;
      const historicalLatencyText = siteHistoricalHealth?.avgLatencyMs == null
        ? '—'
        : `${siteHistoricalHealth.avgLatencyMs}ms`;
      const channelRuntimeLoad = channelLoadSnapshots[i];
      const runtimeHealthText = siteRuntimeDetail.modelKey
        ? `${siteRuntimeDetail.combinedMultiplier.toFixed(2)}（站点=${siteRuntimeDetail.globalMultiplier.toFixed(2)}，模型=${siteRuntimeDetail.modelMultiplier.toFixed(2)}）`
        : `${siteRuntimeDetail.globalMultiplier.toFixed(2)}`;
      const runtimeLoadText = formatChannelRuntimeLoad(channelRuntimeLoad);
      const recentSuccessRateText = `${(siteRuntimeDetail.recentSuccessRate * 100).toFixed(1)}%`;
      const stableFirstSuccessRate = resolveStableFirstSuccessRate(siteRuntimeDetail, siteHistoricalHealth?.successRate);
      const stableFirstSuccessRateText = `${(stableFirstSuccessRate * 100).toFixed(1)}%`;
      const stableSiteOrder = this.getStableFirstSiteOrder(candidates, candidate.site.id);
      const reasonPrefix = selectionMode === 'stable_first'
        ? (
          candidates.length === 1
            ? '稳定优先（唯一可用候选'
            : `稳定优先（综合评分第 ${rankByIndex.get(i) ?? 1} / ${candidates.length}`
        )
        : (
          candidates.length === 1
            ? '按权重随机（唯一可用候选'
            : '按权重随机'
        );
      const stablePoolText = selectionMode === 'stable_first'
        ? `，轮询顺位=P${stableSiteOrder}`
        : '';
      return {
        candidate,
        probability,
        reason: selectionMode === 'stable_first'
          ? `${reasonPrefix}，近期成功率=${recentSuccessRateText}（样本=${siteRuntimeDetail.recentSampleCount.toFixed(2)}，置信=${siteRuntimeDetail.recentConfidence.toFixed(2)}），回退成功率=${historicalSuccessRateText}，综合近期成功率=${stableFirstSuccessRateText}，运行时健康=${runtimeHealthText}，会话负载=${runtimeLoadText}，同站点通道=${siteChannels}${stablePoolText}，评分占比≈${(probability * 100).toFixed(1)}%）`
          : (
            candidates.length === 1
              ? `${reasonPrefix}，W=${weight}，成本=${costSourceText}:${(cost?.unitCost || 1).toFixed(6)}，站点权重=${siteGlobalWeight.toFixed(2)}x下游倍率=${normalizedDownstreamSiteMultiplier.toFixed(2)}=${combinedSiteWeight.toFixed(2)}，运行时健康=${runtimeHealthText}，会话负载=${runtimeLoadText}，历史健康=${siteHistoricalMultiplier.toFixed(2)}（成功率=${historicalSuccessRateText}，均延迟=${historicalLatencyText}，样本=${siteHistoricalHealth?.totalCalls ?? 0}），同站点通道=${siteChannels}，概率≈${(probability * 100).toFixed(1)}%）`
              : `按权重随机（W=${weight}，成本=${costSourceText}:${(cost?.unitCost || 1).toFixed(6)}，站点权重=${siteGlobalWeight.toFixed(2)}x下游倍率=${normalizedDownstreamSiteMultiplier.toFixed(2)}=${combinedSiteWeight.toFixed(2)}，运行时健康=${runtimeHealthText}，会话负载=${runtimeLoadText}，历史健康=${siteHistoricalMultiplier.toFixed(2)}（成功率=${historicalSuccessRateText}，均延迟=${historicalLatencyText}，样本=${siteHistoricalHealth?.totalCalls ?? 0}），同站点通道=${siteChannels}，概率≈${(probability * 100).toFixed(1)}%）`
          ),
      };
    });

    let selected = candidates[rankedIndices[0] ?? 0];
    if (selectionMode === 'weighted') {
      const selectedIndex = selectWeightedIndex(contributions);
      selected = candidates[selectedIndex ?? (candidates.length - 1)];
    } else {
      selected = this.selectStableFirstCandidate(
        candidates,
        contributions,
        rankedIndices,
        stableFirstRotationKey,
      ) ?? selected;
    }

    return {
      selected,
      details,
      stableSiteCount: stableSiteIds.size,
    };
  }

  private getStableFirstSiteLeaderIndices(
    candidates: RouteChannelCandidate[],
    contributions: number[],
    rankedIndices: number[],
  ): number[] {
    if (rankedIndices.length <= 1) return rankedIndices;

    const siteLeaderIndices: number[] = [];
    const seenSiteIds = new Set<number>();
    for (const index of rankedIndices) {
      const siteId = candidates[index]?.site.id;
      if (!Number.isFinite(siteId) || seenSiteIds.has(siteId)) continue;
      seenSiteIds.add(siteId);
      siteLeaderIndices.push(index);
    }

    if (siteLeaderIndices.length <= 1) return siteLeaderIndices;

    const bestContribution = contributions[siteLeaderIndices[0] ?? rankedIndices[0] ?? 0] ?? 0;
    const stableSiteLeaderIndices = siteLeaderIndices.filter((index) => (
      isContributionCloseToBest(contributions[index] ?? 0, bestContribution)
    ));

    return stableSiteLeaderIndices.length > 0 ? stableSiteLeaderIndices : siteLeaderIndices;
  }

  private selectStableFirstCandidate(
    candidates: RouteChannelCandidate[],
    contributions: number[],
    rankedIndices: number[],
    stableFirstRotationKey?: string,
  ): RouteChannelCandidate | null {
    const stableSiteLeaderIndices = this.getStableFirstSiteLeaderIndices(candidates, contributions, rankedIndices);
    if (stableSiteLeaderIndices.length <= 0) return candidates[rankedIndices[0] ?? 0] ?? null;

    const orderedSiteLeaderIndices = this.getStableFirstOrderedSiteLeaderIndices(candidates, stableSiteLeaderIndices);
    const lastSelectedSiteId = stableFirstRotationKey
      ? getStableFirstLastSelectedSiteByKey().get(stableFirstRotationKey)
      : undefined;
    const lastSelectedIndex = typeof lastSelectedSiteId === 'number'
      ? orderedSiteLeaderIndices.findIndex((index) => candidates[index]?.site.id === lastSelectedSiteId)
      : -1;
    const selectedSiteLeader = orderedSiteLeaderIndices[lastSelectedIndex >= 0
      ? ((lastSelectedIndex + 1) % orderedSiteLeaderIndices.length)
      : 0];
    if (selectedSiteLeader == null) return candidates[rankedIndices[0] ?? 0] ?? null;

    const selectedSiteId = candidates[selectedSiteLeader]?.site.id;
    const topSiteCandidateIndex = rankedIndices.find((index) => candidates[index]?.site.id === selectedSiteId);
    return topSiteCandidateIndex == null ? (candidates[selectedSiteLeader] ?? null) : (candidates[topSiteCandidateIndex] ?? null);
  }
}

export const tokenRouter = new TokenRouter();

export const __tokenRouterTestUtils = {
  resolveMappedModel,
  getStableFirstRotationCacheSize: () => getStableFirstLastSelectedSiteByKey().size,
  rememberStableFirstSiteSelectionForKey,
};

