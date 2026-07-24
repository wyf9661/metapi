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
} from './proxyChannelRetry.js';

const originalProxyMaxChannelAttempts = config.proxyMaxChannelAttempts;
const originalBudget = (config as any).proxyChannelFailoverBudgetMs;

afterEach(() => {
  config.proxyMaxChannelAttempts = originalProxyMaxChannelAttempts;
  (config as any).proxyChannelFailoverBudgetMs = originalBudget;
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

    // 14 candidates → min(14, softCap 8) = 8
    expect(getProxyEffectiveMaxChannelAttempts(14)).toBe(8);
    expect(getProxyEffectiveMaxChannelRetries(14)).toBe(7);
    // multi-channel → explicit budget if set, else soft default 45s
    expect(getProxyEffectiveFailoverBudgetMs(14)).toBe(45_000);

    // 2 candidates → min(2, 8) = 2 (small pool fully covered)
    expect(getProxyEffectiveMaxChannelAttempts(2)).toBe(2);
    expect(getProxyEffectiveMaxChannelRetries(2)).toBe(1);
    // multi-channel → soft default 45s
    expect(getProxyEffectiveFailoverBudgetMs(2)).toBe(45_000);

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
});
