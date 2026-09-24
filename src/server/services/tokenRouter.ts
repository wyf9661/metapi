import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { refreshModelPricingCatalog } from './modelPricingService.js';

import { type SiteRuntimeFailureContext } from './siteFailureClassification.js';

import type { RouteChannelCandidate, RouteMatch, RouteRow } from './tokenRouterTypes.js';
import { compareNullableTimeAsc, compareNullableTimeDesc } from './tokenRouterMath.js';
import {
  buildStableFirstPoolPlan,
  shouldUseStableFirstObservationCandidate,
  updateStableFirstObservationProgress,
} from './tokenRouterStableFirstPlan.js';

import {
  getStableFirstLastSelectedSiteByKey,
  rememberStableFirstSiteSelectionForKey,
} from './tokenRouterStableFirstMemory.js';
import {
  ensureSiteRuntimeHealthStateLoaded,
  filterSiteRuntimeBrokenCandidatesByModel,
} from './tokenRouterRuntimeHealthStore.js';
import { selectWithBoundedGap, type BoundedGapState } from './boundedGapSelection.js';
import {
  attachBoundedGapStateMap,
  ensureBoundedGapStatesLoaded,
  markBoundedGapStateDirty,
} from './boundedGapPersistence.js';

import { resolveDownstreamPolicyModel } from './downstreamPolicyTypes.js';
import { type DownstreamRoutingPolicy } from './downstreamPolicyTypes.js';
import { aggregateSiteScoresPerAccount } from './tokenRouterSiteAggregation.js';

import { ensureSiteContextCapabilityLoaded } from './siteContextCapabilityService.js';
import { filterRecentlyFailedCandidates, isChannelRecentlyFailed } from './tokenRouterFailurePolicy.js';
// Kept on this module's public surface: both were exported from here before the
// failure policy moved out, and callers (and their tests) import them from here.
export { filterRecentlyFailedCandidates, isChannelRecentlyFailed } from './tokenRouterFailurePolicy.js';
import { isOauthRouteUnitCandidate, resolveRouteStrategy } from './tokenRouterCandidateHelpers.js';
import {
  invalidateRouteScopedCache,
  loadEnabledRoutes,
  loadRouteMatch,
  patchCachedChannel,
} from './tokenRouterRouteCache.js';
// Re-exported: external callers (sites/tokens routes, modelService, oauth route
// units) import the cache invalidator from this module, as before the split.
export { invalidateTokenRouterCache } from './tokenRouterRouteCache.js';

import {
  buildVisibleEnabledRoutes,
  getExposedModelNameForRoute,
  isExplicitGroupRoute,
  isModelAllowedByDownstreamPolicy,
  isRouteDisplayNameMatch,
  normalizeChannelSourceModel,
  resolveMappedModel,
  resolveModelResolution,
  type ModelResolution,
} from './tokenRouterModelMatching.js';
import { isExactRouteModelPattern, matchesModelPattern } from './tokenRouterModelPatterns.js';
import {
  formatShadowSelectionLog,
  rankShadowCandidates,
  type ShadowCandidateInput,
} from './routeScoringShadow.js';

import {
  loadConnectivityLookup,
  resolveCandidateConnectivity,
  softAvoidDisconnectedCandidates,
  type ConnectivityLookup,
  type ConnectivitySignal,
} from './routeConnectivityLookup.js';

import { type RouteDecision, type RouteDecisionReasonCode } from '../../shared/tokenRouteContract.js';

interface SelectedChannel {
  channel: typeof schema.routeChannels.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  token: typeof schema.accountTokens.$inferSelect | null;
  tokenValue: string;
  tokenName: string;
  actualModel: string;
}

// 余额/配额耗尽（"Insufficient Balance" 等）的固定冷却：这类状态只能靠充值或
// 人工解除，恢复探测对它无效。用一个小时量级的固定冷却把渠道从探测池里摘出去，
// 同时保留路由层 1 小时后自动复检一次的机会（与「冷却上限 1 小时」的约定一致）。

export type WeightedSelectionMode = 'weighted' | 'stable_first';
export type WeightedSelectionResult = {
  selected: RouteChannelCandidate | null;
  details: Array<{ candidate: RouteChannelCandidate; probability: number; reason: string }>;
  stableSiteCount: number;
};

const boundedGapStates = new Map<string, BoundedGapState>();
attachBoundedGapStateMap(boundedGapStates);

function getBoundedGapState(requestedModel: string, siteId: number, channelId?: number): BoundedGapState {
  const key = channelId != null
    ? `${requestedModel}\u0000${siteId}\u0000ch:${channelId}`
    : `${requestedModel}\u0000${siteId}`;
  const existing = boundedGapStates.get(key);
  if (existing) return existing;
  const state = { sequence: 0, lastSelectedSequence: null };
  boundedGapStates.set(key, state);
  return state;
}

export type RouteDecisionExplanation = RouteDecision & {
  routeId?: number;
  modelPattern?: string;
  selectedAccountId?: number;
  modelResolution?: ModelResolution;
};

export type ExplainSelectionOptions = {
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

export type CandidateEligibilityReason = {
  code: RouteDecisionReasonCode;
  message: string;
  details?: Record<string, unknown>;
};

export type CandidateEligibilityOptions = {
  requestedModel: string;
  bypassSourceModelCheck?: boolean;
  excludeChannelIds?: number[];
  nowIso?: string;
  downstreamPolicy?: DownstreamRoutingPolicy;
  /** Request's estimated context requirement (input + output budget + margin). */
  requiredContextTokens?: number;
  /** Availability-first: relax a cooldown that came from a HEALTH PROBE when it
   * would be the only reason the candidate set is empty. Real-failure and
   * credential-scoped cooldowns stay hard exclusions (see
   * isProbeAttributableCooldown). */
  ignoreProbeCooldown?: boolean;
};

import {
  STICKY_PREFERRED_YIELD_LOW_COVERAGE,
  resolvePreferredBalanceCoverage,
  type PreferredChannelSelectionOptions,
} from './routeStickyPreferencePolicy.js';
import {
  clearChannelFailureState,
  clearFailureCooldown,
  recordFailure,
  recordProbeFailure,
  recordProbeSuccess,
  recordSuccess,
} from './tokenRouterFailureRecording.js';
import {
  DEFAULT_DOWNSTREAM_POLICY,
  buildRouteUnitMemberDispatchCandidate,
  buildShadowCandidateInputs,
  buildStableFirstRotationKey,
  calculateWeightedSelection,
  explainSelectionFromMatch,
  getCandidateEligibilityReasons,
  getEligibleRouteUnitMembers,
  getRoundRobinCandidates,
  isKeylessApiConnection,
  resolveChannelTokenValue,
  resolveRouteUnitMemberTokenValue,
} from './tokenRouterSelectionEngine.js';

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
import { recordNoChannelDiagnostic } from './proxyNoChannelDiagnostics.js';

export class TokenRouter {
  /**
   * Find matching route and select a channel for the given model.
   * Returns null if no route/channel available.
   */
  async selectChannel(requestedModel: string, downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY, options?: { requiredContextTokens?: number }): Promise<SelectedChannel | null> {
    const effectiveModel = resolveDownstreamPolicyModel(requestedModel, downstreamPolicy);
    if (!isModelAllowedByDownstreamPolicy(effectiveModel, downstreamPolicy)) return null;
    await ensureSiteRuntimeHealthStateLoaded();
    await ensureSiteContextCapabilityLoaded();
    await ensureBoundedGapStatesLoaded();

    const match = await this.findRoute(effectiveModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, effectiveModel, downstreamPolicy, [], true, options?.requiredContextTokens);
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
    options?: { requiredContextTokens?: number },
  ): Promise<number> {
    const effectiveModel = resolveDownstreamPolicyModel(requestedModel, downstreamPolicy);
    if (!isModelAllowedByDownstreamPolicy(effectiveModel, downstreamPolicy)) return 0;
    await ensureSiteRuntimeHealthStateLoaded();
    await ensureSiteContextCapabilityLoaded();
    const match = await this.findRoute(effectiveModel, downstreamPolicy);
    if (!match) return 0;
    const nowIso = new Date().toISOString();
    const requestedByDisplayName = isRouteDisplayNameMatch(effectiveModel, match.route.displayName);
    const countWith = (contextTokens?: number): number => match.channels.filter((candidate) => (
      this.getCandidateEligibilityReasons(candidate, {
        requestedModel: effectiveModel,
        bypassSourceModelCheck: requestedByDisplayName,
        excludeChannelIds,
        nowIso,
        downstreamPolicy,
        requiredContextTokens: contextTokens,
      }).length === 0
    )).length;
    const eligibleCount = countWith(options?.requiredContextTokens);
    if (
      eligibleCount === 0
      && (options?.requiredContextTokens ?? 0) > 0
      && config.contextAwareRouting !== 'off'
    ) {
      // Same availability-first fallback as selectFromMatch so the failover
      // budget is sized for the set the attempt will actually use.
      return countWith(undefined);
    }
    return eligibleCount;
  }

  async selectNextChannel(
    requestedModel: string,
    excludeChannelIds: number[],
    downstreamPolicy: DownstreamRoutingPolicy = DEFAULT_DOWNSTREAM_POLICY,
    options?: { requiredContextTokens?: number },
  ): Promise<SelectedChannel | null> {
    const effectiveModel = resolveDownstreamPolicyModel(requestedModel, downstreamPolicy);
    if (!isModelAllowedByDownstreamPolicy(effectiveModel, downstreamPolicy)) return null;
    await ensureSiteRuntimeHealthStateLoaded();
    await ensureSiteContextCapabilityLoaded();

    const match = await this.findRoute(effectiveModel, downstreamPolicy);
    if (!match) return null;
    return await this.selectFromMatch(match, effectiveModel, downstreamPolicy, excludeChannelIds, true, options?.requiredContextTokens);
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
    await ensureSiteContextCapabilityLoaded();

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

    private async explainSelectionFromMatch(match: RouteMatch | null, requestedModel: string, options: ExplainSelectionOptions = {}) : Promise<RouteDecisionExplanation> {
    return explainSelectionFromMatch(match, requestedModel, options);
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

  async recordSuccess(channelId: number, latencyMs: number, cost: number, modelName?: string | null, actualAccountId?: number) {
    return recordSuccess(channelId, latencyMs, cost, modelName, actualAccountId);
  }

    async recordProbeSuccess(channelId: number, latencyMs: number, modelName?: string | null, actualAccountId?: number) {
    return recordProbeSuccess(channelId, latencyMs, modelName, actualAccountId);
  }

  async recordProbeFailure(channelId: number, options: { inconclusive?: boolean; quotaExhausted?: boolean } = {}, nowMs: number = Date.now()) {
    return recordProbeFailure(channelId, options, nowMs);
  }

  async clearChannelFailureState(channelIds: number[]) : Promise<number> {
    return clearChannelFailureState(channelIds);
  }

  async recordFailure(channelId: number, context: SiteRuntimeFailureContext | string | null = {}, actualAccountId?: number) {
    return recordFailure(channelId, context, actualAccountId);
  }

  async clearFailureCooldown(channelId: number) : Promise<void> {
    return clearFailureCooldown(channelId);
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

    private buildShadowCandidateInputs(candidates: RouteChannelCandidate[], modelName: string | ((candidate: RouteChannelCandidate) => string), downstreamPolicy: DownstreamRoutingPolicy, nowMs: number, connectivityLookup?: ConnectivityLookup | null, requestedModel?: string) : ShadowCandidateInput[] {
    return buildShadowCandidateInputs(candidates, modelName, downstreamPolicy, nowMs, connectivityLookup, requestedModel);
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
      const ranked = rankShadowCandidates(inputs, {
        probabilityFloor: config.routeProbabilityFloor ?? 0.05,
      });
      const active = ranked.candidates.filter((c) => !c.factors.exclusion && c.score > 0 && c.probability > 0);
      let selectedId = ranked.selectedChannelId;
      // Probability-proportional selection with a bounded gap. Normal traffic
      // remains score-weighted, but a healthy low-probability candidate that has
      // reached ceil(1 / probability) calls since its last selection gets one
      // real request before weighted sampling resumes.
      if (active.length > 1) {
        // Site-level aggregation is quota-aware: best key per ACCOUNT (+ bounded
        // bonus for extra same-account keys), summed over accounts. Sharing one
        // quota pool must not multiply a site's share by its key count.
        const siteScores = aggregateSiteScoresPerAccount(active.map((row) => ({
          siteId: row.siteId,
          accountId: row.accountId,
          channelId: row.channelId,
          score: row.score,
        })));
        const siteIds = [...siteScores.keys()];
        const bounded = selectWithBoundedGap(
          siteIds.map((siteId) => siteScores.get(siteId) ?? 0),
          siteIds.map((siteId) => getBoundedGapState(requestedModel, siteId)),
        );
        if (bounded) {
          const selectedSiteId = siteIds[bounded.selectedIndex];
          const siteRows = active.filter((row) => row.siteId === selectedSiteId);
          if (siteRows.length > 1) {
            const inner = selectWithBoundedGap(
              siteRows.map((row) => row.score),
              siteRows.map((row) => getBoundedGapState(requestedModel, selectedSiteId, row.channelId)),
            );
            if (inner) {
              selectedId = siteRows[inner.selectedIndex]?.channelId ?? selectedId;
            }
          } else {
            selectedId = siteRows[0]?.channelId ?? selectedId;
          }
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
      const shadow = rankShadowCandidates(inputs, {
        probabilityFloor: config.routeProbabilityFloor ?? 0.05,
      });
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
    requiredContextTokens?: number,
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
    const eligibilityOptions = {
      requestedModel,
      bypassSourceModelCheck,
      excludeChannelIds,
      nowIso,
      downstreamPolicy,
      requiredContextTokens,
    };
    let available = match.channels.filter((candidate) => (
      this.getCandidateEligibilityReasons(candidate, eligibilityOptions).length === 0
    ));

    if (
      available.length === 0
      && requiredContextTokens != null && requiredContextTokens > 0
      && config.contextAwareRouting !== 'off'
    ) {
      // Availability first: the context filter must never be the ONLY reason a
      // request ends up with no channel at all. Learned limits can be stale
      // (site upgraded, misparsed error) and the requirement is an estimate —
      // fall back to the full candidate set and let the attempt itself decide.
      available = match.channels.filter((candidate) => (
        this.getCandidateEligibilityReasons(candidate, {
          ...eligibilityOptions,
          requiredContextTokens: undefined,
        }).length === 0
      ));
    }

    if (available.length === 0) {
      // Availability-first: a cooldown written by a HEALTH PROBE is a
      // prediction, not an observation — don't let it be the ONLY reason the
      // pool is empty (mirrors the context-filter pattern above). Cooldowns
      // from real traffic failures and credential-scoped (usage limit)
      // exclusions are deliberately not relaxed: retrying a usage-limited
      // account, or one that just failed real traffic, only wastes the request.
      available = match.channels.filter((candidate) => (
        this.getCandidateEligibilityReasons(candidate, {
          ...eligibilityOptions,
          requiredContextTokens: undefined,
          ignoreProbeCooldown: true,
        }).length === 0
      ));
      if (available.length > 0) {
        console.warn(
          `[probe-cooldown-fallback] ${requestedModel}: every candidate was ` +
          'parked by a health probe, falling back to the candidate set',
        );
      }
    }

    if (available.length === 0) {
      // These reasons are computed for every candidate and would otherwise be
      // discarded, leaving the 503 report unable to say which condition emptied
      // the pool (cooldown / account / site / token / context / policy).
      recordNoChannelDiagnostic({
        model: requestedModel,
        stage: 'no_eligible_candidate',
        poolSize: match.channels.length,
        candidates: match.channels.map((candidate) => ({
          channelId: candidate.channel.id,
          reasons: this.getCandidateEligibilityReasons(candidate, eligibilityOptions),
        })),
      });
      return null;
    }

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

    // Candidates passed the eligibility check but scoring/dispatch still picked
    // none (all probabilities zeroed, or dispatch resolution refused) — record
    // the pool so a repeat is not misread as "every candidate was excluded".
    recordNoChannelDiagnostic({
      model: requestedModel,
      stage: 'dispatch_no_selection',
      poolSize: available.length,
      candidates: available.map((candidate) => ({ channelId: candidate.channel.id, reasons: [] })),
    });
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
        requiredContextTokens: options?.requiredContextTokens,
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
  }) : string | null {
    return resolveRouteUnitMemberTokenValue(candidate);
  }

    private buildRouteUnitMemberDispatchCandidate(outerCandidate: RouteChannelCandidate, memberCandidate: RouteChannelCandidate['routeUnitMembers'][number]) : RouteChannelCandidate {
    return buildRouteUnitMemberDispatchCandidate(outerCandidate, memberCandidate);
  }

  

    private getEligibleRouteUnitMembers(candidate: RouteChannelCandidate, options: CandidateEligibilityOptions) : RouteChannelCandidate['routeUnitMembers'] {
    return getEligibleRouteUnitMembers(candidate, options);
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

    private isKeylessApiConnection(candidate: {
    channel: typeof schema.routeChannels.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    token: typeof schema.accountTokens.$inferSelect | null;
  }) : boolean {
    return isKeylessApiConnection(candidate);
  }

    private resolveChannelTokenValue(candidate: {
    channel: typeof schema.routeChannels.$inferSelect;
    account: typeof schema.accounts.$inferSelect;
    site?: typeof schema.sites.$inferSelect | null;
    token: typeof schema.accountTokens.$inferSelect | null;
  }) : string | null {
    return resolveChannelTokenValue(candidate);
  }

  

    private getCandidateEligibilityReasons(candidate: RouteChannelCandidate, options: CandidateEligibilityOptions) : CandidateEligibilityReason[] {
    return getCandidateEligibilityReasons(candidate, options);
  }

    private getRoundRobinCandidates(candidates: RouteChannelCandidate[]) : RouteChannelCandidate[] {
    return getRoundRobinCandidates(candidates);
  }

  private selectRoundRobinCandidate(candidates: RouteChannelCandidate[]): RouteChannelCandidate | null {
    return this.getRoundRobinCandidates(candidates)[0] ?? null;
  }

  

    private buildStableFirstRotationKey(routeId: number, requestedModel: string) : string {
    return buildStableFirstRotationKey(routeId, requestedModel);
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
    if (!tokenValue && !this.isKeylessApiConnection(dispatchCandidate)) return null;
    const dispatchTokenValue = tokenValue || '';

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
      tokenValue: dispatchTokenValue,
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

    private calculateWeightedSelection(candidates: RouteChannelCandidate[], modelName: string | ((candidate: RouteChannelCandidate) => string), downstreamPolicy: DownstreamRoutingPolicy, nowMs = Date.now(), selectionMode: WeightedSelectionMode = 'weighted', stableFirstRotationKey?: string) : WeightedSelectionResult {
    return calculateWeightedSelection(candidates, modelName, downstreamPolicy, nowMs, selectionMode, stableFirstRotationKey);
  }

  

  
}

export const tokenRouter = new TokenRouter();

export const __tokenRouterTestUtils = {
  resolveMappedModel,
  getStableFirstRotationCacheSize: () => getStableFirstLastSelectedSiteByKey().size,
  rememberStableFirstSiteSelectionForKey,
};

