import { config } from '../config.js';

export function getProxyMaxChannelAttempts(): number {
  const attempts = Math.trunc(config.proxyMaxChannelAttempts || 0);
  return attempts > 0 ? attempts : 1;
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
