import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig, config } from '../config.js';
import {
  canRetryProxyChannel,
  canRetryProxyChannelWithBudget,
  getProxyChannelFailoverBudgetMs,
  getProxyEffectiveFailoverBudgetMs,
  getProxyEffectiveMaxChannelAttempts,
  getProxyEffectiveMaxChannelRetries,
  getProxyMaxChannelAttempts,
  getProxyMaxChannelRetries,
  resolveProxyChannelFirstByteTimeoutMs,
  resolveProxyFailoverDerivedBudgetMs,
} from './proxyChannelRetry.js';

const originalProxyMaxChannelAttempts = config.proxyMaxChannelAttempts;
const originalBudget = (config as any).proxyChannelFailoverBudgetMs;
const originalFirstByteTimeoutSec = (config as any).proxyFirstByteTimeoutSec;

afterEach(() => {
  config.proxyMaxChannelAttempts = originalProxyMaxChannelAttempts;
  (config as any).proxyChannelFailoverBudgetMs = originalBudget;
  (config as any).proxyFirstByteTimeoutSec = originalFirstByteTimeoutSec;
});

describe('proxyChannelRetry', () => {
  it('parses proxy max channel attempts from config with a safer default', () => {
    expect(buildConfig({} as NodeJS.ProcessEnv).proxyMaxChannelAttempts).toBe(5);
    expect(buildConfig({ PROXY_MAX_CHANNEL_ATTEMPTS: '3' } as NodeJS.ProcessEnv).proxyMaxChannelAttempts).toBe(3);
  });

  it('derives retry budget from total channel attempts', () => {
    config.proxyMaxChannelAttempts = 5;

    expect(getProxyMaxChannelAttempts()).toBe(5);
    expect(getProxyMaxChannelRetries()).toBe(4);
    expect(canRetryProxyChannel(3)).toBe(true);
    expect(canRetryProxyChannel(4)).toBe(false);
  });

  it('clamps invalid runtime config to at least one channel attempt', () => {
    config.proxyMaxChannelAttempts = 0;

    expect(getProxyMaxChannelAttempts()).toBe(1);
    expect(getProxyMaxChannelRetries()).toBe(0);
    expect(canRetryProxyChannel(0)).toBe(false);
  });

  it('defaults aggregate wall-clock budget off and still honors explicit values', () => {
    expect(buildConfig({} as NodeJS.ProcessEnv).proxyChannelFailoverBudgetMs).toBe(0);
    config.proxyMaxChannelAttempts = 3;
    (config as any).proxyChannelFailoverBudgetMs = 1000;
    expect(getProxyChannelFailoverBudgetMs()).toBe(1000);
    expect(canRetryProxyChannelWithBudget(0, 100)).toBe(true);
    expect(canRetryProxyChannelWithBudget(0, 1000)).toBe(false);
    expect(canRetryProxyChannelWithBudget(2, 100)).toBe(false); // attempts exhausted
  });

  it('caps multi-channel pools at the soft attempt ceiling', () => {
    config.proxyMaxChannelAttempts = 5;
    (config as any).proxyChannelFailoverBudgetMs = 0;
    (config as any).proxyFirstByteTimeoutSec = 30;

    // 14 candidates → min(14, softCap 8) = 8
    expect(getProxyEffectiveMaxChannelAttempts(14)).toBe(8);
    expect(getProxyEffectiveMaxChannelRetries(14)).toBe(7);
    // multi-channel → derived budget full + 2*probe = 30 + 2*15 = 60s
    expect(getProxyEffectiveFailoverBudgetMs(14)).toBe(60_000);

    // 2 candidates → min(2, 8) = 2 (small pool fully covered)
    expect(getProxyEffectiveMaxChannelAttempts(2)).toBe(2);
    expect(getProxyEffectiveMaxChannelRetries(2)).toBe(1);
    // multi-channel → derived budget 60s
    expect(getProxyEffectiveFailoverBudgetMs(2)).toBe(60_000);

    // single candidate → unlimited budget
    expect(getProxyEffectiveFailoverBudgetMs(1)).toBe(0);
  });

  it('respects explicit failover budget override', () => {
    (config as any).proxyChannelFailoverBudgetMs = 20_000;
    // explicit budget overrides soft default
    expect(getProxyEffectiveFailoverBudgetMs(3)).toBe(20_000);
    expect(getProxyEffectiveFailoverBudgetMs(1)).toBe(0);
  });

  it('accepts explicit maxRetries override in budget gate', () => {
    config.proxyMaxChannelAttempts = 3;
    (config as any).proxyChannelFailoverBudgetMs = 10_000;
    expect(canRetryProxyChannelWithBudget(2, 100, 10_000, 5)).toBe(true);
    expect(canRetryProxyChannelWithBudget(5, 100, 10_000, 5)).toBe(false);
  });

  it('uses the full first-byte timeout for every attempt (probe = full)', () => {
    // Slow-but-alive relay sites legitimately take 30-60s for the first byte;
    // halving the timeout on failover probes killed exactly those sites.
    (config as any).proxyFirstByteTimeoutSec = 60;
    expect(resolveProxyChannelFirstByteTimeoutMs(0)).toBe(60_000);
    expect(resolveProxyChannelFirstByteTimeoutMs(1)).toBe(60_000);
    expect(resolveProxyChannelFirstByteTimeoutMs(5)).toBe(60_000);

    (config as any).proxyFirstByteTimeoutSec = 30;
    expect(resolveProxyChannelFirstByteTimeoutMs(1)).toBe(30_000);

    (config as any).proxyFirstByteTimeoutSec = 10;
    expect(resolveProxyChannelFirstByteTimeoutMs(1)).toBe(10_000);

    // full = 300s → probe still 300s (no cap: a slow site gets the full wait)
    (config as any).proxyFirstByteTimeoutSec = 300;
    expect(resolveProxyChannelFirstByteTimeoutMs(1)).toBe(300_000);

    // full = 0 (disabled) → probes also disabled
    (config as any).proxyFirstByteTimeoutSec = 0;
    expect(resolveProxyChannelFirstByteTimeoutMs(0)).toBe(0);
    expect(resolveProxyChannelFirstByteTimeoutMs(1)).toBe(0);
  });

  it('derives failover budget as full + probe (≈ 2× full)', () => {
    (config as any).proxyFirstByteTimeoutSec = 60;
    // 60s + 60s = 120s
    expect(resolveProxyFailoverDerivedBudgetMs()).toBe(120_000);
    expect(getProxyEffectiveFailoverBudgetMs(3)).toBe(120_000);

    (config as any).proxyFirstByteTimeoutSec = 30;
    // 30s + 30s = 60s
    expect(resolveProxyFailoverDerivedBudgetMs()).toBe(60_000);

    // disabled → 0 (no budget cap)
    (config as any).proxyFirstByteTimeoutSec = 0;
    expect(resolveProxyFailoverDerivedBudgetMs()).toBe(0);
    expect(getProxyEffectiveFailoverBudgetMs(5)).toBe(0);
  });
});
