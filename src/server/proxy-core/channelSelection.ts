import * as routeRefreshWorkflow from '../services/routeRefreshWorkflow.js';
import {
  ensureProxyChannelAffinityLoaded,
  proxyChannelCoordinator,
} from '../services/proxyChannelCoordinator.js';
import { config } from '../config.js';
import {
  canRetryProxyChannelWithBudget,
  getProxyEffectiveFailoverBudgetMs,
  getProxyEffectiveMaxChannelRetries,
  getProxyMaxChannelRetries,
} from '../services/proxyChannelRetry.js';
import type { DownstreamRoutingPolicy } from '../services/downstreamPolicyTypes.js';
import { tokenRouter } from '../services/tokenRouter.js';
import { logRouteSelection } from '../services/routeSelectionLog.js';

type SelectedChannel = Awaited<ReturnType<typeof tokenRouter.selectChannel>>;

export const TESTER_FORCED_CHANNEL_HEADER = 'x-metapi-tester-forced-channel-id';
export const TESTER_REQUEST_HEADER = 'x-metapi-tester-request';

function headerValueEquals(
  headers: Record<string, unknown> | undefined,
  expectedKey: string,
  expectedValue: string,
): boolean {
  if (!headers) return false;
  const normalizedExpectedKey = expectedKey.trim().toLowerCase();
  const normalizedExpectedValue = expectedValue.trim().toLowerCase();
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== normalizedExpectedKey) continue;
    if (typeof rawValue === 'string' && rawValue.trim().toLowerCase() === normalizedExpectedValue) {
      return true;
    }
  }
  return false;
}

function isLoopbackClientIp(value: string | null | undefined): boolean {
  const trimmed = (value || '').trim();
  if (!trimmed) return false;
  if (trimmed === '::1' || trimmed === '127.0.0.1') return true;
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length).trim() === '127.0.0.1';
  }
  return false;
}

export function normalizeForcedChannelId(value: unknown): number | null {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : NaN;
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

type TesterRequestInput = {
  headers?: Record<string, unknown>;
  clientIp?: string | null;
};

export function isTrustedTesterRequest(input?: TesterRequestInput): boolean {
  if (!input) return false;
  if (!isLoopbackClientIp(input.clientIp)) return false;
  return headerValueEquals(input.headers, TESTER_REQUEST_HEADER, '1');
}

export function getTesterForcedChannelId(input?: TesterRequestInput): number | null {
  if (!isTrustedTesterRequest(input)) return null;
  const headers = input?.headers;
  if (!headers) return null;
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== TESTER_FORCED_CHANNEL_HEADER) continue;
    return normalizeForcedChannelId(rawValue);
  }
  return null;
}

export function buildForcedChannelUnavailableMessage(forcedChannelId?: number | null): string {
  const normalizedForcedChannelId = normalizeForcedChannelId(forcedChannelId);
  if (normalizedForcedChannelId === null) {
    return 'No available channels for this model';
  }
  return `指定通道 #${normalizedForcedChannelId} 当前不可用，固定通道模式不会自动切换其他通道`;
}

export function canRetryChannelSelection(
  retryCount: number,
  forcedChannelId?: number | null,
  elapsedMs?: number | null,
  options?: {
    maxRetries?: number;
    budgetMs?: number;
  },
): boolean {
  if (normalizeForcedChannelId(forcedChannelId) !== null) return false;
  const maxRetries = options?.maxRetries ?? getProxyMaxChannelRetries();
  const budgetMs = options?.budgetMs;
  return canRetryProxyChannelWithBudget(retryCount, elapsedMs, budgetMs, maxRetries);
}

/** Resolve adaptive maxRetries + wall-clock budget from eligible candidate count. */
export function resolveProxyFailoverLimits(candidateCount: number): {
  maxRetries: number;
  budgetMs: number;
  attempts: number;
} {
  const maxRetries = getProxyEffectiveMaxChannelRetries(candidateCount);
  const budgetMs = getProxyEffectiveFailoverBudgetMs(candidateCount);
  return {
    maxRetries,
    budgetMs,
    attempts: maxRetries + 1,
  };
}

export async function selectProxyChannelForAttempt(input: {
  requestedModel: string;
  downstreamPolicy: DownstreamRoutingPolicy;
  excludeChannelIds: number[];
  retryCount: number;
  stickySessionKey?: string | null;
  forcedChannelId?: number | null;
  downstreamApiKeyId?: number | null;
}): Promise<SelectedChannel> {
  await ensureProxyChannelAffinityLoaded();
  const normalizedForcedChannelId = normalizeForcedChannelId(input.forcedChannelId);
  if (normalizedForcedChannelId !== null) {
    if (input.retryCount > 0) return null;
    return await tokenRouter.selectPreferredChannel(
      input.requestedModel,
      normalizedForcedChannelId,
      input.downstreamPolicy,
      input.excludeChannelIds,
    );
  }

  let selected: SelectedChannel = null;
  let refreshedRoutes = false;
  let preferredSource: 'sticky' | 'last_success' | null = null;

  const refreshRoutesForFirstAttempt = async (): Promise<boolean> => {
    if (input.retryCount > 0 || refreshedRoutes) return false;
    refreshedRoutes = true;
    try {
      await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
      return true;
    } catch (error) {
      console.warn('[proxy/surface] failed to refresh routes after empty selection', error);
      return false;
    }
  };

  const tryPreferredChannel = async (
    preferredChannelId: number,
    source: 'sticky' | 'last_success',
  ): Promise<SelectedChannel> => {
    if (preferredChannelId <= 0 || input.excludeChannelIds.includes(preferredChannelId)) {
      return null;
    }
    const selectionOptions = { yieldOnLowBalance: true };
    let preferred = await tokenRouter.selectPreferredChannel(
      input.requestedModel,
      preferredChannelId,
      input.downstreamPolicy,
      input.excludeChannelIds,
      selectionOptions,
    );
    if (!preferred) {
      const refreshSucceeded = await refreshRoutesForFirstAttempt();
      preferred = await tokenRouter.selectPreferredChannel(
        input.requestedModel,
        preferredChannelId,
        input.downstreamPolicy,
        input.excludeChannelIds,
        selectionOptions,
      );
      if (!preferred && refreshSucceeded) {
        if (source === 'sticky' && input.stickySessionKey) {
          proxyChannelCoordinator.clearStickyChannel(input.stickySessionKey, preferredChannelId);
        }
        if (source === 'last_success') {
          proxyChannelCoordinator.clearLastSuccessChannel({
            requestedModel: input.requestedModel,
            downstreamApiKeyId: input.downstreamApiKeyId,
            channelId: preferredChannelId,
          });
        }
      }
    }
    if (preferred) preferredSource = source;
    return preferred;
  };

  if (input.retryCount === 0) {
    // Probability-Guarded Routing: each first-hop request independently skips
    // sticky and last-success affinity with probability `probeRate`, forcing
    // a balanced-v2 weighted sample. This keeps short-session traffic
    // converging to the configured weights without waiting for a long sticky
    // hit-chain to reach its cap. The last-success anchor is unaffected:
    // failover paths (retryCount > 0) still prefer the known-good channel.
    const shouldProbe = !input.forcedChannelId
      && Math.random() < config.proxyRouteProbeRate;
    if (!shouldProbe && input.stickySessionKey) {
      const stickyChannelId = proxyChannelCoordinator.getStickyChannelId(input.stickySessionKey);
      if (stickyChannelId) {
        const hitCount = proxyChannelCoordinator.incrementStickyHitCount(input.stickySessionKey);
        if (hitCount > config.proxyStickyMaxHits) {
          // Consecutive-hit cap reached: discard the session-level affinity so
          // dense same-key traffic re-enters balanced-v2 instead of
          // monopolizing one site. IMPORTANT: do NOT fall through into
          // last_success here — the model-level memory would point at the same
          // channel (it was successful before), silently re-locking the site
          // and starving the weighted distribution. Forcing balanced-v2 keeps
          // the long-run request mix aligned with the configured weights.
          proxyChannelCoordinator.clearStickyChannel(input.stickySessionKey, stickyChannelId);
        } else {
          selected = await tryPreferredChannel(stickyChannelId, 'sticky');
        }
      }
    }
    if (!selected && !shouldProbe) {
      const lastSuccessChannelId = proxyChannelCoordinator.getLastSuccessChannelId({
        requestedModel: input.requestedModel,
        downstreamApiKeyId: input.downstreamApiKeyId,
      });
      if (lastSuccessChannelId) {
        const explore = proxyChannelCoordinator.shouldExploreFromLastSuccess({
          requestedModel: input.requestedModel,
          downstreamApiKeyId: input.downstreamApiKeyId,
          explorationInterval: config.proxyLastSuccessExplorationInterval,
        });
        if (!explore) {
          // Model-level last-success affinity is an event-driven safety net:
          // it has no hit-count cap (unlike the session-level sticky binding,
          // which re-balances to avoid one client monopolizing a channel).
          // A good channel stays preferred until it fails or an exploration
          // replaces it with another successful channel.
          selected = await tryPreferredChannel(lastSuccessChannelId, 'last_success');
        }
      }
    }
  }

  if (!selected && input.retryCount > 0) {
    // Failover recovery anchor: when the current channel failed and we are
    // switching sites, prefer the model-level last-success memory so a good
    // channel (successful moments ago and not yet excluded) is tried before
    // falling back to weighted randomness. The surface already clears that
    // memory for the failing channel itself, so this only helps when another
    // healthy channel is known-good. This applies regardless of the first-hop
    // sticky cap: a failed attempt should always fall back to the known-good
    // anchor before burning more budget on random choices.
    const lastSuccessChannelId = proxyChannelCoordinator.getLastSuccessChannelId({
      requestedModel: input.requestedModel,
      downstreamApiKeyId: input.downstreamApiKeyId,
    });
    if (lastSuccessChannelId) {
      selected = await tryPreferredChannel(lastSuccessChannelId, 'last_success');
    }
  }

  if (!selected) {
    selected = input.retryCount === 0
      ? await tokenRouter.selectChannel(input.requestedModel, input.downstreamPolicy)
      : await tokenRouter.selectNextChannel(
        input.requestedModel,
        input.excludeChannelIds,
        input.downstreamPolicy,
      );
  }

  if (!selected && input.retryCount === 0 && !refreshedRoutes) {
    await refreshRoutesForFirstAttempt();
    selected = await tokenRouter.selectChannel(input.requestedModel, input.downstreamPolicy);
  }

  const stickyHit = preferredSource === 'sticky' || !!(
    input.stickySessionKey
    && selected
    && proxyChannelCoordinator.getStickyChannelId(input.stickySessionKey) === selected.channel.id
  );
  logRouteSelection({
    requestedModel: input.requestedModel,
    selected,
    retryCount: input.retryCount,
    sticky: stickyHit || preferredSource === 'last_success',
    forcedChannelId: input.forcedChannelId,
    reason: input.forcedChannelId
      ? 'forced'
      : preferredSource === 'sticky'
        ? 'sticky'
        : preferredSource === 'last_success'
          ? 'last_success'
          : (input.retryCount > 0 ? 'failover' : 'primary'),
  });

  return selected;
}
