import { config } from '../config.js';

export function getProxyMaxChannelAttempts(): number {
  const attempts = Math.trunc(config.proxyMaxChannelAttempts || 0);
  return attempts > 0 ? attempts : 1;
}

/** Minimum eligible candidates before the adaptive budget can meaningfully deviate from the static cap. */
const ADAPTIVE_ATTEMPTS_MIN_CANDIDATES = 4;

/**
 * Compute retry budget scaled to the actual candidate pool size.
 *
 * When many channels match a model (e.g. 14 candidates for grok-4.5) the
 * static cap of 3 attempts would give up too early.  This helper returns
 * `ceil(candidateCount * 0.4) - 1` (bounded by proxyMaxChannelAttempts)
 * so that routes with 10+ channels get 4-5 retries rather than only 2.
 *
 * Callers that know the candidate set size before the failover loop starts
 * should use this instead of `getProxyMaxChannelRetries()`.
 */
export function getProxyEffectiveMaxChannelRetries(candidateCount: number): number {
  const staticAttempts = getProxyMaxChannelAttempts();
  if (candidateCount >= ADAPTIVE_ATTEMPTS_MIN_CANDIDATES && staticAttempts >= 3) {
    const adaptive = Math.ceil(candidateCount * 0.4);
    return Math.max(0, Math.min(staticAttempts, adaptive) - 1);
  }
  return Math.max(0, staticAttempts - 1);
}

export function getProxyMaxChannelRetries(): number {
  return Math.max(0, getProxyMaxChannelAttempts() - 1);
}

/** Wall-clock budget for multi-channel failover (ms). 0 = disabled. */
export function getProxyChannelFailoverBudgetMs(): number {
  const budget = Math.trunc((config as { proxyChannelFailoverBudgetMs?: number }).proxyChannelFailoverBudgetMs || 0);
  return budget > 0 ? budget : 0;
}

export function canRetryProxyChannel(retryCount: number): boolean {
  return retryCount < getProxyMaxChannelRetries();
}

/**
 * Channel failover gate: attempt count + optional wall-clock budget so clients
 * do not wait through every slow channel until they time out themselves.
 */
export function canRetryProxyChannelWithBudget(
  retryCount: number,
  elapsedMs?: number | null,
  budgetMs: number = getProxyChannelFailoverBudgetMs(),
): boolean {
  if (!canRetryProxyChannel(retryCount)) return false;
  if (!budgetMs || budgetMs <= 0) return true;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) return true;
  return elapsedMs < budgetMs;
}
