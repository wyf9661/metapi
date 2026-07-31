import { config } from '../config.js';
import { getCredentialModeFromExtraConfig } from './accountExtraConfig.js';
import { getCachedModelRoutingReferenceCost } from './modelPricingService.js';
import { computeBalanceCoverage } from './routeScoringShadow.js';

/**
 * Sticky/last-success preferred hops skip the balanced-v2 score, so a session
 * account whose balance is nearly exhausted can otherwise be drained by dense
 * same-key traffic. Yield when known balance coverage drops below this many
 * expected requests (mirrors routeScoringShadow low-balance band < 5).
 */
export const STICKY_PREFERRED_YIELD_LOW_COVERAGE = 5;

export type PreferredChannelSelectionOptions = {
  /** Yield (return null) when the preferred channel's known balance coverage is low. */
  yieldOnLowBalance?: boolean;
};

type CostSignal = {
  unitCost: number;
  source: 'observed' | 'configured' | 'catalog' | 'fallback';
};

type RouteChannelCandidate = {
  account: {
    id: number;
    extraConfig?: string | null;
    apiToken?: string | null;
    accessToken?: string | null;
    balance?: number | null;
    unitCost?: number | null;
    lastBalanceRefresh?: string | null;
  };
  channel: {
    id: number;
    successCount?: number | null;
    totalCost?: number | null;
    sourceModel?: string | null;
  };
  site: {
    id: number;
  };
};

const MIN_EFFECTIVE_UNIT_COST = 1e-6;

/**
 * Resolve effective per-token cost from observed usage, configured rate, catalog pricing,
 * or fallback default. Used to estimate how many requests a session balance can cover.
 */
export function resolveEffectiveUnitCost(
  candidate: RouteChannelCandidate,
  modelName: string,
): CostSignal {
  const successCount = Math.max(0, candidate.channel.successCount ?? 0);
  const totalCost = Math.max(0, candidate.channel.totalCost ?? 0);
  const configured = candidate.account.unitCost ?? null;

  if (successCount > 0 && totalCost > 0) {
    return {
      unitCost: Math.max(totalCost / successCount, MIN_EFFECTIVE_UNIT_COST),
      source: 'observed',
    };
  }

  if (configured != null && configured > 0) {
    return {
      unitCost: Math.max(configured, MIN_EFFECTIVE_UNIT_COST),
      source: 'configured',
    };
  }

  const catalogCost = getCachedModelRoutingReferenceCost({
    siteId: candidate.site.id,
    accountId: candidate.account.id,
    modelName,
  });
  if (catalogCost != null && catalogCost > 0) {
    return {
      unitCost: Math.max(catalogCost, MIN_EFFECTIVE_UNIT_COST),
      source: 'catalog',
    };
  }

  return {
    unitCost: Math.max(config.routingFallbackUnitCost || 1, MIN_EFFECTIVE_UNIT_COST),
    source: 'fallback',
  };
}

/**
 * Resolve how many expected requests the preferred channel's known session
 * balance can still cover. Returns null when balance is unknown (direct
 * API-key/free accounts) or not yet refreshed — callers must not yield then.
 */
export function resolvePreferredBalanceCoverage(
  candidate: RouteChannelCandidate,
  modelName: string,
): number | null {
  const account = candidate.account;
  const credentialMode = getCredentialModeFromExtraConfig(account.extraConfig);
  const hasApiToken = typeof account.apiToken === 'string' && account.apiToken.trim().length > 0;
  const hasAccessToken = typeof account.accessToken === 'string' && account.accessToken.trim().length > 0;
  const looksLikeDirectApiKey = credentialMode === 'apikey' || (hasApiToken && !hasAccessToken);
  const isSessionCredential = !looksLikeDirectApiKey && (credentialMode === 'session' || hasAccessToken);
  const lastBalanceRefresh = account.lastBalanceRefresh;
  const balanceRefreshed = typeof lastBalanceRefresh === 'string' && lastBalanceRefresh.trim().length > 0;
  if (!isSessionCredential || !balanceRefreshed) return null;
  const balanceRaw = account.balance;
  const balance = typeof balanceRaw === 'number' && Number.isFinite(balanceRaw) ? balanceRaw : null;
  if (balance == null) return null;
  const cost = resolveEffectiveUnitCost(candidate, modelName);
  return computeBalanceCoverage(balance, cost.unitCost);
}
