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

  it('honors wall-clock failover budget', () => {
    config.proxyMaxChannelAttempts = 3;
    (config as any).proxyChannelFailoverBudgetMs = 1000;
    expect(getProxyChannelFailoverBudgetMs()).toBe(1000);
    expect(canRetryProxyChannelWithBudget(0, 100)).toBe(true);
    expect(canRetryProxyChannelWithBudget(0, 1000)).toBe(false);
    expect(canRetryProxyChannelWithBudget(2, 100)).toBe(false); // attempts exhausted
  });

  it('scales attempts and budget for large candidate pools', () => {
    config.proxyMaxChannelAttempts = 5;
    (config as any).proxyChannelFailoverBudgetMs = 8_000;

    // 14 candidates → ceil(14*0.4)=6 attempts (> base 5)
    expect(getProxyEffectiveMaxChannelAttempts(14)).toBe(6);
    expect(getProxyEffectiveMaxChannelRetries(14)).toBe(5);
    // budget scales with attempts * 2500 but not below base
    expect(getProxyEffectiveFailoverBudgetMs(14)).toBe(15_000);

    // small pool stays at base
    expect(getProxyEffectiveMaxChannelAttempts(2)).toBe(5);
    expect(getProxyEffectiveMaxChannelRetries(2)).toBe(4);
    expect(getProxyEffectiveFailoverBudgetMs(2)).toBe(12_500);
  });

  it('accepts explicit maxRetries override in budget gate', () => {
    config.proxyMaxChannelAttempts = 3;
    (config as any).proxyChannelFailoverBudgetMs = 10_000;
    expect(canRetryProxyChannelWithBudget(2, 100, 10_000, 5)).toBe(true);
    expect(canRetryProxyChannelWithBudget(5, 100, 10_000, 5)).toBe(false);
  });
});
