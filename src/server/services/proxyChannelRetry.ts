import { config } from '../config.js';

/** Hard ceiling so adaptive expansion cannot thrash forever. */
export const PROXY_ADAPTIVE_CHANNEL_ATTEMPTS_CEILING = 8;

export function getProxyMaxChannelAttempts(): number {
  const attempts = Math.trunc(config.proxyMaxChannelAttempts || 0);
  return attempts > 0 ? attempts : 1;
}

/** Minimum eligible candidates before adaptive expansion is meaningful. */
const ADAPTIVE_ATTEMPTS_MIN_CANDIDATES = 4;

/**
 * Total channel attempts (not retries) for a known eligible candidate pool.
 *
 * Policy:
 * - start from proxyMaxChannelAttempts (default 5)
 * - when candidates >= 4, expand to max(base, ceil(candidates * 0.4))
 * - never exceed PROXY_ADAPTIVE_CHANNEL_ATTEMPTS_CEILING (8)
 */
export function getProxyEffectiveMaxChannelAttempts(candidateCount: number): number {
  const base = getProxyMaxChannelAttempts();
  const count = Math.max(0, Math.trunc(candidateCount || 0));
  if (count >= ADAPTIVE_ATTEMPTS_MIN_CANDIDATES) {
    const adaptive = Math.ceil(count * 0.4);
    return Math.max(1, Math.min(PROXY_ADAPTIVE_CHANNEL_ATTEMPTS_CEILING, Math.max(base, adaptive)));
  }
  return Math.max(1, base);
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

/** Wall-clock budget for multi-channel failover (ms). 0 = disabled. */
export function getProxyChannelFailoverBudgetMs(): number {
  const budget = Math.trunc((config as { proxyChannelFailoverBudgetMs?: number }).proxyChannelFailoverBudgetMs || 0);
  return budget > 0 ? budget : 0;
}

/**
 * Scale wall-clock failover budget with effective attempts so larger pools
 * are not cut off by the default 8s budget after only 2-3 slow failures.
 * Returns 0 when base budget is disabled.
 */
export function getProxyEffectiveFailoverBudgetMs(candidateCount: number): number {
  const base = getProxyChannelFailoverBudgetMs();
  if (base <= 0) return 0;
  const attempts = getProxyEffectiveMaxChannelAttempts(candidateCount);
  // ~2.5s per attempt, never below configured base, capped at 20s.
  const scaled = Math.max(base, attempts * 2_500);
  return Math.min(20_000, scaled);
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
