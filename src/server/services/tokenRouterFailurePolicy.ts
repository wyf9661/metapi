/**
 * Failure-cooldown policy, and the recently-failed candidate helpers built on it.
 *
 * Second slice of the `tokenRouter.ts` split. Policy and helpers move as one unit
 * because the helpers resolve the configured ceiling through the policy; keeping
 * them apart would make this module import the router back.
 *
 * Deliberately left behind: `getBoundedGapState` (reads router state) and
 * `QUOTA_EXHAUSTED_COOLDOWN_MS` (still used by the router class).
 */
import { schema } from '../db/index.js';
import { config, normalizeTokenRouterFailureCooldownMaxSec, TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING } from '../config.js';
import {
  classifyProxyFailure,
  isUsageLimitRateLimitFailure,
  type SiteRuntimeFailureContext,
} from './siteFailureClassification.js';
import {
  clampFailureCooldownMs as clampFailureCooldownMsMath,
  resolveEffectiveFailureCooldownMs as resolveEffectiveFailureCooldownMsMath,
  resolveFailureBackoffSec,
} from './tokenRouterMath.js';
import {
  filterRecentlyFailedCandidates as filterRecentlyFailedCandidatesPure,
  isChannelRecentlyFailed as isChannelRecentlyFailedPure,
  type FailureAwareChannel,
} from './tokenRouterCandidateFilter.js';

/** How long a channel sits out after a short-window usage-limit rejection. */
export const SHORT_WINDOW_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

export function resolveConfiguredFailureCooldownMaxMs(): number {
  const normalized = normalizeTokenRouterFailureCooldownMaxSec(config.tokenRouterFailureCooldownMaxSec)
    ?? TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING;
  return Math.max(1_000, normalized * 1000);
}

export function clampFailureCooldownMs(cooldownMs: number): number {
  return clampFailureCooldownMsMath(cooldownMs, resolveConfiguredFailureCooldownMaxMs());
}

export function resolveEffectiveFailureCooldownMs(failCount?: number | null, weight = 1): number {
  const maxMs = resolveConfiguredFailureCooldownMaxMs();
  const rawBackoffMs = resolveEffectiveFailureCooldownMsMath(failCount, maxMs);
  const normalizedWeight = Number.isFinite(weight)
    ? Math.max(0.1, Math.min(3, Number(weight)))
    : 1;
  // Apply weight BEFORE clamping so the ceiling cannot be exceeded by weight
  return clampFailureCooldownMsMath(rawBackoffMs * normalizedWeight, maxMs);
}

export function resolveFailureCooldownWeight(context: SiteRuntimeFailureContext = {}): {
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


export function resolveShortWindowLimitCooldown(
  _account: typeof schema.accounts.$inferSelect,
  context: SiteRuntimeFailureContext = {},
  nowMs = Date.now(),
): string | null {
  const status = typeof context.status === 'number' ? context.status : 0;
  const errorText = (context.errorText || '').trim();
  if (!isUsageLimitRateLimitFailure({ status, errorText })) return null;

  return new Date(nowMs + SHORT_WINDOW_LIMIT_COOLDOWN_MS).toISOString();
}

export function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

/** Compact token-count label for eligibility messages (131072 -> 131K). */
export function formatContextTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return String(tokens);
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
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
