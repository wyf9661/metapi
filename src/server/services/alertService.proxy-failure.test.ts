import { describe, expect, it } from 'vitest';
import { formatProxyFailureAlert } from './alertService.js';

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
