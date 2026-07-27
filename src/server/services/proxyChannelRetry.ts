import { config } from '../config.js';
import {
  classifyProxyFailure,
  isLowValueFailoverFailureClass,
  type ProxyFailureClass,
} from './siteFailureClassification.js';

/** Soft ceiling so huge free-pool models (20+ channels) cannot thrash for minutes. */
export const PROXY_CHANNEL_FAILOVER_SOFT_ATTEMPT_CAP_DEFAULT = 8;
/** Soft wall-clock budget for multi-channel failover when env leaves budget unset (0). */
export const PROXY_CHANNEL_FAILOVER_SOFT_BUDGET_MS_DEFAULT = 45_000;
/** After the first channel, use a shorter first-byte probe for remaining candidates. */
export const PROXY_CHANNEL_FAILOVER_PROBE_FIRST_BYTE_TIMEOUT_MS_DEFAULT = 15_000;
/** Stop after this many consecutive low-value failure classes (WAF/model/quota/ambiguous). */
export const PROXY_CHANNEL_FAILOVER_LOW_VALUE_STREAK_STOP_DEFAULT = 2;

export function getProxyMaxChannelAttempts(): number {
  const attempts = Math.trunc(config.proxyMaxChannelAttempts || 0);
  return attempts > 0 ? attempts : 1;
}

/**
 * Soft cap for live multi-channel failover.
 * Env: PROXY_CHANNEL_FAILOVER_MAX_ATTEMPTS (default 8). Always at least 1.
 */
export function getProxyChannelFailoverSoftAttemptCap(): number {
  const raw = Math.trunc(
    (config as { proxyChannelFailoverMaxAttempts?: number }).proxyChannelFailoverMaxAttempts
      ?? PROXY_CHANNEL_FAILOVER_SOFT_ATTEMPT_CAP_DEFAULT,
  );
  return raw > 0 ? raw : PROXY_CHANNEL_FAILOVER_SOFT_ATTEMPT_CAP_DEFAULT;
}

/**
 * Total channel attempts (not retries) for a known eligible candidate pool.
 * Uses min(pool, softCap) so exhaustive walk still covers small pools fully.
 */
export function getProxyEffectiveMaxChannelAttempts(candidateCount: number): number {
  const count = Math.max(0, Math.trunc(candidateCount || 0));
  if (count <= 0) return getProxyMaxChannelAttempts();
  return Math.min(count, getProxyChannelFailoverSoftAttemptCap());
}

/**
 * Retry budget (maxRetries) scaled to the candidate pool.
 * Surfaces loop with `while (retryCount <= maxRetries)`.
 */
export function getProxyEffectiveMaxChannelRetries(candidateCount: number): number {
  return Math.max(0, getProxyEffectiveMaxChannelAttempts(candidateCount) - 1);
}

export function getProxyMaxChannelRetries(): number {
  return Math.max(0, getProxyMaxChannelAttempts() - 1);
}

/**
 * Configured aggregate wall-clock budget (ms). 0 means "use soft default on live path".
 * Set PROXY_CHANNEL_FAILOVER_BUDGET_MS explicitly to override.
 */
export function getProxyChannelFailoverBudgetMs(): number {
  const budget = Math.trunc((config as { proxyChannelFailoverBudgetMs?: number }).proxyChannelFailoverBudgetMs || 0);
  return budget > 0 ? budget : 0;
}

/**
 * Live-path wall-clock budget:
 * - single candidate → 0 (no multi-channel wait)
 * - multi candidate → explicit env budget if >0, else soft default 30s
 */
export function getProxyEffectiveFailoverBudgetMs(candidateCount: number): number {
  const count = Math.max(0, Math.trunc(candidateCount || 0));
  if (count <= 1) return 0;
  const explicit = getProxyChannelFailoverBudgetMs();
  if (explicit > 0) return explicit;
  return PROXY_CHANNEL_FAILOVER_SOFT_BUDGET_MS_DEFAULT;
}

export function canRetryProxyChannel(
  retryCount: number,
  maxRetries: number = getProxyMaxChannelRetries(),
): boolean {
  return retryCount < Math.max(0, Math.trunc(maxRetries));
}

/**
 * Channel failover gate: attempt count + optional wall-clock budget so clients
 * do not wait through every slow channel until they time out themselves.
 */
export function canRetryProxyChannelWithBudget(
  retryCount: number,
  elapsedMs?: number | null,
  budgetMs: number = getProxyChannelFailoverBudgetMs(),
  maxRetries: number = getProxyMaxChannelRetries(),
): boolean {
  if (!canRetryProxyChannel(retryCount, maxRetries)) return false;
  if (!budgetMs || budgetMs <= 0) return true;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) return true;
  return elapsedMs < budgetMs;
}

/**
 * First-byte timeout for channel attempt N.
 * First attempt uses full config timeout; later attempts use a short probe so
 * failover does not spend a full generation timeout validating bad channels.
 */
export function resolveProxyChannelFirstByteTimeoutMs(retryCount: number): number {
  const fullMs = Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000));
  if (retryCount <= 0) return fullMs;
  if (fullMs <= 0) return PROXY_CHANNEL_FAILOVER_PROBE_FIRST_BYTE_TIMEOUT_MS_DEFAULT;
  return Math.min(fullMs, PROXY_CHANNEL_FAILOVER_PROBE_FIRST_BYTE_TIMEOUT_MS_DEFAULT);
}

export type FailoverStreakState = {
  lowValueStreak: number;
  lastClass: ProxyFailureClass | null;
};

export function createFailoverStreakState(): FailoverStreakState {
  return { lowValueStreak: 0, lastClass: null };
}

/**
 * Update streak from a channel failure. Returns whether failover should stop
 * (no more channel switches) even if attempt budget remains.
 */
export function noteFailoverFailureAndShouldStop(
  state: FailoverStreakState,
  status: number,
  errorText?: string | null,
  stopAfter: number = PROXY_CHANNEL_FAILOVER_LOW_VALUE_STREAK_STOP_DEFAULT,
): boolean {
  const decision = classifyProxyFailure({ status, errorText });
  state.lastClass = decision.class;
  if (isLowValueFailoverFailureClass(decision.class)) {
    state.lowValueStreak += 1;
  } else {
    state.lowValueStreak = 0;
  }
  return state.lowValueStreak >= Math.max(1, Math.trunc(stopAfter));
}
