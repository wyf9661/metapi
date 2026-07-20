import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig, config } from '../config.js';
import {
  canRetryProxyChannel,
  canRetryProxyChannelWithBudget,
  getProxyChannelFailoverBudgetMs,
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
});
