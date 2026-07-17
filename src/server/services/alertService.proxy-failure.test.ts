import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetProxyFailureNotifyStateForTests,
  createProxyFailureNotifyKey,
  evaluateProxyFailureNotifyThrottle,
  formatProxyFailureAlert,
  PROXY_FAILURE_NOTIFY_COOLDOWN_MS,
  shouldPushProxyFailureNotification,
} from './alertService.js';

describe('formatProxyFailureAlert', () => {
  it('defaults to request-failed wording, not all-channels-failed', () => {
    const alert = formatProxyFailureAlert({
      model: 'gpt-5.6-sol',
      reason: 'upstream returned HTTP 403',
      attemptedChannels: 1,
      configuredAttempts: 3,
    });
    expect(alert.title).toBe('代理请求失败');
    expect(alert.message).toContain('模型=gpt-5.6-sol');
    expect(alert.message).toContain('已尝试=1/3');
    expect(alert.title).not.toContain('全部失败');
  });

  it('uses all-attempted wording only when outcome says so', () => {
    const alert = formatProxyFailureAlert({
      model: 'gpt-5.6-sol',
      reason: 'socket hang up',
      outcome: 'all_attempted_channels_failed',
      attemptedChannels: 3,
      configuredAttempts: 3,
      retryBudgetExhausted: true,
    });
    expect(alert.title).toBe('已尝试渠道均失败');
    expect(alert.message).toContain('终止=故障转移预算耗尽');
  });

  it('labels empty candidate set distinctly', () => {
    const alert = formatProxyFailureAlert({
      model: 'gpt-5.6-sol',
      reason: 'No available channels after retries',
      outcome: 'no_available_channels',
      attemptedChannels: 0,
      configuredAttempts: 3,
    });
    expect(alert.title).toBe('代理无可用渠道');
  });
});

describe('proxy failure notify policy', () => {
  beforeEach(() => {
    __resetProxyFailureNotifyStateForTests();
  });

  it('does not push external notify for single request_failed', () => {
    expect(shouldPushProxyFailureNotification('request_failed')).toBe(false);
    expect(shouldPushProxyFailureNotification('all_attempted_channels_failed')).toBe(true);
    expect(shouldPushProxyFailureNotification('no_available_channels')).toBe(true);
  });

  it('throttles same model+outcome for 10 minutes regardless of reason text', () => {
    const key = createProxyFailureNotifyKey('GPT-5.6-sol', 'all_attempted_channels_failed');
    expect(key).toBe('all_attempted_channels_failed||gpt-5.6-sol');

    const first = evaluateProxyFailureNotifyThrottle('gpt-5.6-sol', 'all_attempted_channels_failed', 1_000);
    expect(first.shouldSend).toBe(true);

    const second = evaluateProxyFailureNotifyThrottle('gpt-5.6-sol', 'all_attempted_channels_failed', 2_000);
    expect(second.shouldSend).toBe(false);

    const afterCooldown = evaluateProxyFailureNotifyThrottle(
      'gpt-5.6-sol',
      'all_attempted_channels_failed',
      1_000 + PROXY_FAILURE_NOTIFY_COOLDOWN_MS + 1,
    );
    expect(afterCooldown.shouldSend).toBe(true);
    expect(afterCooldown.suppressedSinceLast).toBe(1);
  });
});
