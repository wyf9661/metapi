/**
 * Candidate selection and decision-explanation engine.
 *
 * Extracted from tokenRouter.ts as one self-contained cluster: every member
 * below only calls the others (no instance fields are touched), so they live at
 * module scope as plain functions and TokenRouter keeps thin delegates for the
 * ones its remaining methods still call. `this.x(...)` became `x(...)`.
 */
import { schema } from '../db/index.js';
import { config } from '../config.js';
import { proxyChannelCoordinator } from './proxyChannelCoordinator.js';
import { compareNullableTimeAsc, isContributionCloseToBest, resolveFailureBackoffSec } from './tokenRouterMath.js';
import { RouteChannelCandidate, RouteMatch } from './tokenRouterTypes.js';
import { STABLE_FIRST_OBSERVATION_REQUEST_INTERVAL, buildSiteHistoricalHealthMetrics, buildStableFirstPoolPlan, compareStableFirstCandidateOrder, resolveStableFirstSuccessRate, shouldUseStableFirstObservationCandidate } from './tokenRouterStableFirstPlan.js';
import { getStableFirstLastSelectedSiteByKey, getStableFirstObservationProgressByKey } from './tokenRouterStableFirstMemory.js';
import { filterSiteRuntimeBrokenCandidatesByModel, getSiteRuntimeHealthDetails } from './tokenRouterRuntimeHealthStore.js';
import { buildContributionRanks, countCandidatesBySite, normalizeContributions, normalizeValueScores, rankContributionIndices, selectWeightedIndex } from './tokenRouterProbability.js';
import { DownstreamRoutingPolicy, EMPTY_DOWNSTREAM_ROUTING_POLICY } from './downstreamPolicyTypes.js';
import { isUsableAccountToken } from './accountTokenService.js';
import { getCredentialModeFromExtraConfig } from './accountExtraConfig.js';
import { lookupSiteContextLimitForNames } from './siteContextCapabilityService.js';
import { filterRecentlyFailedCandidates, formatContextTokens, isChannelRecentlyFailed, isSiteDisabled } from './tokenRouterFailurePolicy.js';
import { formatChannelRuntimeLoad, isExplicitTokenChannel, isOauthRouteUnitCandidate, isOauthRouteUnitMemberCoolingDown, resolveChannelRuntimeLoadMultiplier, resolveRouteStrategy, setCandidateDecisionReason } from './tokenRouterCandidateHelpers.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { getOauthRouteUnitStrategyLabel } from './oauth/routeUnitService.js';
import { channelSupportsRequestedModel, isRouteDisplayNameMatch, normalizeChannelSourceModel, normalizeModelAlias, normalizeRouteDisplayName, resolveMappedModel, resolveModelResolution } from './tokenRouterModelMatching.js';
import { ShadowCandidateInput, rankShadowCandidates } from './routeScoringShadow.js';
import { getPerformanceShadowMetrics } from './performanceShadow.js';
import { ConnectivityLookup, ConnectivitySignal, loadConnectivityLookup, resolveCandidateConnectivity, softAvoidDisconnectedCandidates } from './routeConnectivityLookup.js';
import { siteProtocolAffinityFactor } from '../shared/siteProtocolProfile.js';
import { RouteDecisionCandidate, RouteDecisionReasonCode } from '../../shared/tokenRouteContract.js';
import { resolveEffectiveUnitCost } from './routeStickyPreferencePolicy.js';
import type {
  CandidateEligibilityOptions,
  CandidateEligibilityReason,
  ExplainSelectionOptions,
  RouteDecisionExplanation,
  WeightedSelectionMode,
  WeightedSelectionResult,
} from './tokenRouter.js';

/** Default downstream policy, shared with the router's public entry points. */
export const DEFAULT_DOWNSTREAM_POLICY: DownstreamRoutingPolicy = EMPTY_DOWNSTREAM_ROUTING_POLICY;

export async function explainSelectionFromMatch(
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
    const eligibilityReasons = getCandidateEligibilityReasons(row, {
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
    // Availability-first: a channel cooldown is a temporal signal, not a hard
    // exclusion — don't let it be the ONLY reason the pool is empty (mirrors
    // the context-filter pattern in selectFromMatch so the decision snapshot
    // is consistent with what the live path will choose).
    const relaxed = match.channels.filter((row) => (
      getCandidateEligibilityReasons(row, {
        requestedModel,
        bypassSourceModelCheck,
        excludeChannelIds,
        nowIso,
        downstreamPolicy,
        ignoreChannelCooldown: true,
      }).length === 0
    ));
    if (relaxed.length > 0) {
      for (const row of relaxed) {
        const candidate = candidateMap.get(row.channel.id);
        if (!candidate) continue;
        candidate.eligible = true;
        candidate.reason = '可用（冷却放行 — 临时信号不得清空整个候选池）';
        candidate.reasonCodes = ['eligible'];
      }
      summary.push(`冷却放行：${relaxed.length} 个候选仅处于冷却，已放行给路由选择`);
      available.push(...relaxed);
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
      const rawLayer = getRoundRobinCandidates(layers.get(priority) ?? []);
      const breakerFiltered = filterSiteRuntimeBrokenCandidatesByModel(rawLayer, runtimeModelResolver, nowMs);
      for (const item of breakerFiltered.avoided) {
        const target = candidateMap.get(item.candidate.channel.id);
        if (target) setCandidateDecisionReason(target, 'runtime_health_avoided', item.reason);
      }
      const hasFreshCandidate = breakerFiltered.candidates.some(
        (candidate) => !isChannelRecentlyFailed(candidate.channel, nowMs),
      );
      if (!hasFreshCandidate && layerIndex < sortedPriorities.length - 1) continue;
      ordered = getRoundRobinCandidates(filterRecentlyFailedCandidates(breakerFiltered.candidates, nowMs));
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

    const rotationKey = buildStableFirstRotationKey(match.route.id, requestedModel);
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
    const primaryWeighted = calculateWeightedSelection(
      poolPlan.primaryCandidates,
      useChannelSourceModelForCost ? runtimeModelResolver : mappedModel,
      downstreamPolicy,
      nowMs,
      'stable_first',
      rotationKey,
    );
    const observationWeighted = poolPlan.observationCandidates.length > 0
      ? calculateWeightedSelection(
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
    const shadowInputs = buildShadowCandidateInputs(
      filteredLayer,
      modelForCost,
      downstreamPolicy,
      nowMs,
      connectivityLookup,
      requestedModel,
    );
    const ranked = rankShadowCandidates(shadowInputs, {
      probabilityFloor: config.routeProbabilityFloor ?? 0.05,
    });
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
            + `吞吐=${scored.factors.throughput.toFixed(2)}，`
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

export function buildShadowCandidateInputs(
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
    // Time-to-first-token from live proxy samples (routeId+siteId+model+stream).
    // No sample = null = neutral in scoring. Streaming samples are what users
    // actually feel; non-stream (embeddings etc.) samples are ignored here.
    const ttftSample = getPerformanceShadowMetrics({
      routeId: candidate.channel.routeId,
      siteId: candidate.site.id,
      modelName: model,
      isStream: true,
    }, nowMs);
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
      ttftEwmaMs: ttftSample?.ttftEwmaMs ?? null,
      tpsEwma: ttftSample?.tpsEwma ?? null,
    };
  });
}

export function resolveRouteUnitMemberTokenValue(candidate: {
  account: typeof schema.accounts.$inferSelect;
}): string | null {
  const oauthAccessToken = candidate.account.accessToken?.trim();
  if (oauthAccessToken) return oauthAccessToken;
  const apiToken = candidate.account.apiToken?.trim();
  return apiToken || null;
}

export function buildRouteUnitMemberDispatchCandidate(
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

export function getRouteUnitMemberEligibilityReasons(
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

  const downstreamExclusionReason = resolveDownstreamExclusionReason(
    buildRouteUnitMemberDispatchCandidate(outerCandidate, memberCandidate),
    options.downstreamPolicy,
  );
  if (downstreamExclusionReason) {
    reasonParts.push(downstreamExclusionReason);
  }

  const tokenValue = resolveRouteUnitMemberTokenValue(memberCandidate);
  if (!tokenValue) reasonParts.push('令牌不可用');

  if (isOauthRouteUnitMemberCoolingDown(memberCandidate.member, nowIso)) {
    reasonParts.push('冷却中');
  }

  return reasonParts;
}

export function getEligibleRouteUnitMembers(
  candidate: RouteChannelCandidate,
  options: CandidateEligibilityOptions,
): RouteChannelCandidate['routeUnitMembers'] {
  if (!isOauthRouteUnitCandidate(candidate)) return [];
  return candidate.routeUnitMembers.filter((memberCandidate) => (
    getRouteUnitMemberEligibilityReasons(candidate, memberCandidate, options).length === 0
  ));
}

export function isKeylessApiConnection(candidate: {
  channel: typeof schema.routeChannels.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  token: typeof schema.accountTokens.$inferSelect | null;
}): boolean {
  if (candidate.channel.tokenId || candidate.token) return false;
  if (getOauthInfoFromAccount(candidate.account)) return false;
  let authenticationMode = '';
  try {
    const parsed = JSON.parse(candidate.account.extraConfig || '{}') as Record<string, unknown>;
    authenticationMode = typeof parsed.authenticationMode === 'string'
      ? parsed.authenticationMode.trim().toLowerCase()
      : '';
  } catch {
    return false;
  }
  return getCredentialModeFromExtraConfig(candidate.account.extraConfig) === 'apikey'
    && authenticationMode === 'none'
    && !candidate.account.apiToken?.trim()
    && !candidate.account.accessToken?.trim();
}

export function resolveChannelTokenValue(candidate: {
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

export function resolveDownstreamExclusionReason(
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
      const resolvedTokenValue = resolveChannelTokenValue(candidate);
      const accountApiToken = candidate.account.apiToken?.trim() || '';
      if (resolvedTokenValue && accountApiToken && resolvedTokenValue === accountApiToken) {
        return 'API Key/令牌已被下游密钥排除';
      }
    }
  }

  return null;
}

export function getCandidateEligibilityReasons(
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

  // Context-aware routing: a site whose KNOWN effective context window
  // (learned per site×model from upstream errors / manual pins) cannot fit
  // this request is excluded. Unknown limits never exclude (fail-open —
  // the first overflow on such a site teaches the real value and the next
  // attempt skips it). 'strict' additionally drops unknown-limit sites.
  const requiredContextTokens = Math.trunc(Number(options.requiredContextTokens) || 0);
  if (requiredContextTokens > 0 && config.contextAwareRouting !== 'off') {
    const knownContext = lookupSiteContextLimitForNames(candidate.site.id, [
      candidate.channel.sourceModel,
      options.requestedModel,
    ]);
    if (knownContext && requiredContextTokens > knownContext.limit) {
      addReason(
        'context_insufficient',
        `站点上下文 ${formatContextTokens(knownContext.limit)} < 本次需求 ${formatContextTokens(requiredContextTokens)}`,
        { siteContextLimit: knownContext.limit, requiredContextTokens },
      );
    } else if (!knownContext && config.contextAwareRouting === 'strict') {
      addReason('context_unknown', '站点上下文未知（严格模式）');
    }
  }

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

    if (getEligibleRouteUnitMembers(candidate, options).length === 0) {
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

  const downstreamExclusionReason = resolveDownstreamExclusionReason(candidate, options.downstreamPolicy);
  if (downstreamExclusionReason) {
    addReason('downstream_excluded', downstreamExclusionReason);
  }

  if (excludeChannelIds.includes(candidate.channel.id)) {
    addReason('already_attempted', '当前请求已尝试');
  }

  const tokenValue = resolveChannelTokenValue(candidate);
  if (!tokenValue && !isKeylessApiConnection(candidate)) {
    addReason('token_unavailable', '令牌不可用');
  }

  if (!options.ignoreChannelCooldown && candidate.channel.cooldownUntil && candidate.channel.cooldownUntil > nowIso) {
    addReason('channel_cooldown', '冷却中', { cooldownUntil: candidate.channel.cooldownUntil });
  }

  return reasons;
}

export function getRoundRobinCandidates(candidates: RouteChannelCandidate[]): RouteChannelCandidate[] {
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

export function compareStableFirstCandidates(left: RouteChannelCandidate, right: RouteChannelCandidate): number {
  return compareStableFirstCandidateOrder(left, right);
}

export function buildStableFirstRotationKey(routeId: number, requestedModel: string): string {
  const normalizedModel = normalizeModelAlias(requestedModel)
    || normalizeRouteDisplayName(requestedModel).toLowerCase()
    || String(routeId);
  return `${routeId}:${normalizedModel}`;
}

export function getStableFirstSiteOrder(candidates: RouteChannelCandidate[], siteId: number): number {
  let order = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.site.id !== siteId) continue;
    order = Math.min(order, candidate.channel.priority ?? 0);
  }
  return Number.isFinite(order) ? order : 0;
}

export function getStableFirstOrderedSiteLeaderIndices(
  candidates: RouteChannelCandidate[],
  stableSiteLeaderIndices: number[],
): number[] {
  return [...stableSiteLeaderIndices].sort((leftIndex, rightIndex) => {
    const leftSiteId = candidates[leftIndex]?.site.id ?? 0;
    const rightSiteId = candidates[rightIndex]?.site.id ?? 0;
    const orderDiff = getStableFirstSiteOrder(candidates, leftSiteId)
      - getStableFirstSiteOrder(candidates, rightSiteId);
    if (orderDiff !== 0) return orderDiff;
    return (candidates[leftIndex]?.channel.id ?? 0) - (candidates[rightIndex]?.channel.id ?? 0);
  });
}

export function calculateWeightedSelection(
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
    (leftIndex, rightIndex) => compareStableFirstCandidates(
      candidates[leftIndex],
      candidates[rightIndex],
    ),
  );
  const rankByIndex = buildContributionRanks(rankedIndices);
  const stableSiteLeaderIndices = selectionMode === 'stable_first'
    ? getStableFirstSiteLeaderIndices(candidates, contributions, rankedIndices)
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
    const stableSiteOrder = getStableFirstSiteOrder(candidates, candidate.site.id);
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
    selected = selectStableFirstCandidate(
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

export function getStableFirstSiteLeaderIndices(
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

export function selectStableFirstCandidate(
  candidates: RouteChannelCandidate[],
  contributions: number[],
  rankedIndices: number[],
  stableFirstRotationKey?: string,
): RouteChannelCandidate | null {
  const stableSiteLeaderIndices = getStableFirstSiteLeaderIndices(candidates, contributions, rankedIndices);
  if (stableSiteLeaderIndices.length <= 0) return candidates[rankedIndices[0] ?? 0] ?? null;

  const orderedSiteLeaderIndices = getStableFirstOrderedSiteLeaderIndices(candidates, stableSiteLeaderIndices);
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
