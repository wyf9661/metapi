import { canonicalizeModelName } from '../shared/modelCanonicalization.js';
import { normalizeTokenRouteMode, type RouteMode } from '../../shared/tokenRouteContract.js';
import type { DownstreamRoutingPolicy } from './downstreamPolicyTypes.js';
import {
  isExactRouteModelPattern,
  matchesModelPattern,
} from './tokenRouterModelPatterns.js';

/** Minimal route shape needed by pure model/route matching helpers. */
export type RouteModelMatchInput = {
  id: number;
  enabled?: boolean | null;
  routeMode?: string | null;
  modelPattern: string;
  displayName?: string | null;
  sourceRouteIds?: number[] | null;
};

export function normalizeRouteMode(routeMode: string | null | undefined): RouteMode {
  return normalizeTokenRouteMode(routeMode);
}

export function isExplicitGroupRoute(
  route: Pick<RouteModelMatchInput, 'routeMode'>,
): boolean {
  return normalizeRouteMode(route.routeMode) === 'explicit_group';
}

export function normalizeRouteDisplayName(displayName: string | null | undefined): string {
  return (displayName || '').trim();
}

export function isRouteDisplayNameMatch(
  model: string,
  displayName: string | null | undefined,
): boolean {
  const alias = normalizeRouteDisplayName(displayName);
  return !!alias && alias === model;
}

export function matchesRouteRequestModel(
  model: string,
  route: RouteModelMatchInput,
): boolean {
  if (isExplicitGroupRoute(route)) {
    return isRouteDisplayNameMatch(model, route.displayName);
  }
  return matchesModelPattern(model, route.modelPattern)
    || isRouteDisplayNameMatch(model, route.displayName);
}

export function getExposedModelNameForRoute(route: RouteModelMatchInput): string {
  return normalizeRouteDisplayName(route.displayName) || route.modelPattern;
}

export function hasCustomDisplayName(
  route: Pick<RouteModelMatchInput, 'modelPattern' | 'displayName'>,
): boolean {
  const displayName = normalizeRouteDisplayName(route.displayName);
  const modelPattern = (route.modelPattern || '').trim();
  return !!displayName && displayName !== modelPattern;
}

export function buildVisibleEnabledRoutes<T extends RouteModelMatchInput>(routes: T[]): T[] {
  const coveringGroups = routes.filter((route) => (
    route.enabled
    && (
      (
        isExplicitGroupRoute(route)
        && normalizeRouteDisplayName(route.displayName).length > 0
        && Array.isArray(route.sourceRouteIds)
        && route.sourceRouteIds.length > 0
      )
      || (
        !isExplicitGroupRoute(route)
        && !isExactRouteModelPattern(route.modelPattern)
        && hasCustomDisplayName(route)
      )
    )
  ));

  if (coveringGroups.length === 0) return routes;

  return routes.filter((route) => {
    if (isExplicitGroupRoute(route)) {
      return normalizeRouteDisplayName(route.displayName).length > 0;
    }
    if (!isExactRouteModelPattern(route.modelPattern)) return true;
    if (hasCustomDisplayName(route)) return true;

    const exactModel = (route.modelPattern || '').trim();
    if (!exactModel) return true;

    return !coveringGroups.some((groupRoute) => {
      if (groupRoute.id === route.id) return false;
      if (!normalizeRouteDisplayName(groupRoute.displayName)) return false;
      if (isExplicitGroupRoute(groupRoute)) {
        return (groupRoute.sourceRouteIds || []).includes(route.id);
      }
      return matchesModelPattern(exactModel, groupRoute.modelPattern);
    });
  });
}

export function normalizeModelAlias(modelName: string): string {
  return canonicalizeModelName(modelName);
}

export function isModelAliasEquivalent(left: string, right: string): boolean {
  const a = normalizeModelAlias(left);
  const b = normalizeModelAlias(right);
  return !!a && !!b && a === b;
}

export function channelSupportsRequestedModel(
  channelSourceModel: string | null | undefined,
  requestedModel: string,
): boolean {
  const source = (channelSourceModel || '').trim();
  if (!source) return true;
  if (source === requestedModel) return true;
  if (isModelAliasEquivalent(source, requestedModel)) return true;
  if (matchesModelPattern(requestedModel, source)) return true;
  return false;
}

export function isModelAllowedByDownstreamPolicy(
  requestedModel: string,
  policy: DownstreamRoutingPolicy,
): boolean {
  const supportedPatterns = Array.isArray(policy.supportedModels)
    ? policy.supportedModels
    : [];
  const hasSupportedPatterns = supportedPatterns.length > 0;
  const hasAllowedRoutes = policy.allowedRouteIds.length > 0;
  if (!hasSupportedPatterns && !hasAllowedRoutes) {
    return policy.denyAllWhenEmpty === true ? false : true;
  }
  const matchedSupportedPattern = supportedPatterns.some((pattern) => (
    matchesModelPattern(requestedModel, pattern)
  ));
  if (matchedSupportedPattern) return true;
  if (hasAllowedRoutes) return true;
  return false;
}

export function parseModelMappingRecord(
  modelMapping?: string | Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!modelMapping) return null;
  if (typeof modelMapping === 'object' && !Array.isArray(modelMapping)) {
    return modelMapping as Record<string, unknown>;
  }
  if (typeof modelMapping !== 'string') return null;
  try {
    const parsed = JSON.parse(modelMapping);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function resolveMappedModel(
  requestedModel: string,
  modelMapping?: string | Record<string, unknown> | null,
): string {
  const parsed = parseModelMappingRecord(modelMapping);
  if (!parsed) return requestedModel;

  const entries = Object.entries(parsed)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0) as Array<[string, string]>;

  const exact = entries.find(([pattern]) => pattern === requestedModel);
  if (exact) return exact[1].trim();

  for (const [pattern, target] of entries) {
    if (matchesModelPattern(requestedModel, pattern)) {
      return target.trim();
    }
  }

  return requestedModel;
}

export function normalizeChannelSourceModel(
  channelSourceModel: string | null | undefined,
): string {
  return (channelSourceModel || '').trim();
}

export function resolveActualModelForSelectedChannel(
  requestedModel: string,
  route: Pick<RouteModelMatchInput, 'displayName'>,
  mappedModel: string,
  channelSourceModel: string | null | undefined,
): string {
  const sourceModel = normalizeChannelSourceModel(channelSourceModel);
  if (sourceModel && isModelAliasEquivalent(sourceModel, mappedModel)) {
    return sourceModel;
  }
  if (isRouteDisplayNameMatch(requestedModel, route.displayName) && sourceModel) {
    return sourceModel;
  }
  return mappedModel;
}
