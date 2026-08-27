import { describe, expect, it, vi } from 'vitest';
import {
  formatSub2ApiUsageInline,
  isTruthyFlag,
  parseOauthAccountInfo,
  parsePositiveInt,
  parseSub2ApiAccountUsage,
  resolveAccountCredentialMode,
} from './accountConnection.js';

describe('accountConnection helpers', () => {
  it('resolves account credential mode from explicit mode, capabilities, and token presence', () => {
    expect(resolveAccountCredentialMode({ credentialMode: 'apikey' })).toBe('apikey');
    expect(resolveAccountCredentialMode({ capabilities: { proxyOnly: true } })).toBe('apikey');
    expect(resolveAccountCredentialMode({ accessToken: ' session-token ' })).toBe('session');
    expect(resolveAccountCredentialMode({
      credentialMode: 'session',
      capabilities: { proxyOnly: true },
      accessToken: 'api-token-ignored-by-explicit-mode',
    })).toBe('session');
    expect(resolveAccountCredentialMode({})).toBe('apikey');
  });

  it('parses positive integers from query values', () => {
    expect(parsePositiveInt('42')).toBe(42);
    expect(parsePositiveInt(' 0 ')).toBe(0);
    expect(parsePositiveInt('abc')).toBe(0);
    expect(parsePositiveInt('42abc')).toBe(0);
    expect(parsePositiveInt('1e3')).toBe(0);
    expect(parsePositiveInt('1.5')).toBe(0);
    expect(parsePositiveInt(null)).toBe(0);
  });

  it('treats common truthy query flags as enabled', () => {
    expect(isTruthyFlag('1')).toBe(true);
    expect(isTruthyFlag(' TRUE ')).toBe(true);
    expect(isTruthyFlag('yes')).toBe(true);
    expect(isTruthyFlag('no')).toBe(false);
    expect(isTruthyFlag(null)).toBe(false);
  });
});

describe('parseOauthAccountInfo', () => {
  const makeAccount = (overrides: Record<string, any> = {}) => ({
    id: 1,
    oauthProvider: 'codex',
    extraConfig: '{}',
    ...overrides,
  });

  it('returns null for null / undefined input', () => {
    expect(parseOauthAccountInfo(null)).toBeNull();
    expect(parseOauthAccountInfo(undefined)).toBeNull();
  });

  it('returns null for non-oauth accounts (no oauth key in extraConfig)', () => {
    expect(parseOauthAccountInfo(makeAccount({ extraConfig: '{}' }))).toBeNull();
    expect(parseOauthAccountInfo(makeAccount({ extraConfig: '{"platformUserId":"123"}' }))).toBeNull();
  });

  it('returns null when oauth provider is absent', () => {
    expect(parseOauthAccountInfo(makeAccount({
      extraConfig: JSON.stringify({ oauth: { email: 'test@test.com' } }),
      oauthProvider: '',
    }))).toBeNull();
    expect(parseOauthAccountInfo(makeAccount({
      extraConfig: JSON.stringify({ oauth: { email: 'test@test.com', provider: '' } }),
      oauthProvider: null,
    }))).toBeNull();
  });

  it('detects provider from extraConfig.oauth.provider fallback', () => {
    const result = parseOauthAccountInfo(makeAccount({
      oauthProvider: '',
      extraConfig: JSON.stringify({
        oauth: { provider: 'claude', email: 'a@b.com', planType: 'pro' },
      }),
    }));
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('claude');
    expect(result!.email).toBe('a@b.com');
    expect(result!.planType).toBe('pro');
  });

  it('extracts email, planType, and provider from oauth column first', () => {
    const result = parseOauthAccountInfo(makeAccount({
      oauthProvider: 'codex',
      extraConfig: JSON.stringify({
        oauth: {
          provider: 'claude',
          email: 'user@example.com',
          planType: 'go',
          refreshToken: 'rt.xxx',
          idToken: 'ey.xxx',
        },
      }),
    }));
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('codex'); // oauthProvider column wins
    expect(result!.email).toBe('user@example.com');
    expect(result!.planType).toBe('go');
    expect(result!.quota).toBeNull();
  });

  it('normalises server OauthQuotaSnapshot quota windows (windows.fiveHour / sevenDay)', () => {
    const result = parseOauthAccountInfo(makeAccount({
      oauthProvider: 'codex',
      extraConfig: JSON.stringify({
        oauth: {
          email: 'u@x.com',
          planType: 'plus',
          quota: {
            status: 'supported',
            source: 'official',
            windows: {
              fiveHour: { supported: true, used: 62, limit: 100, remaining: 38, resetAt: '2026-08-27T00:00:00.000Z' },
              sevenDay: { supported: true, used: 20, limit: 100, remaining: 80 },
            },
          },
        },
      }),
    }));
    expect(result).not.toBeNull();
    expect(result!.quota).not.toBeNull();
    expect(result!.quota!.fiveHour).toEqual({
      supported: true, used: 62, limit: 100, remaining: 38, resetAt: '2026-08-27T00:00:00.000Z', message: undefined,
    });
    expect(result!.quota!.sevenDay).toEqual({
      supported: true, used: 20, limit: 100, remaining: 80, resetAt: undefined, message: undefined,
    });
  });

  it('normalises legacy usedPercent/resetAfterSeconds quota shape', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T08:00:00.000Z'));
    try {
      const result = parseOauthAccountInfo(makeAccount({
        oauthProvider: 'codex',
        extraConfig: JSON.stringify({
          oauth: {
            email: 'u@x.com',
            planType: 'pro',
            quota: {
              fiveHour: { usedPercent: 75, resetAfterSeconds: 3600 },
              sevenDay: { usedPercent: 30, resetAfterSeconds: 259200 },
            },
          },
        }),
      }));
      expect(result).not.toBeNull();
      expect(result!.quota).not.toBeNull();
      expect(result!.quota!.fiveHour).toEqual({
        supported: true, used: 75, limit: 100, remaining: 25, resetAt: '2026-08-26T09:00:00.000Z', message: undefined,
      });
      expect(result!.quota!.sevenDay).toEqual({
        supported: true, used: 30, limit: 100, remaining: 70, resetAt: '2026-08-29T08:00:00.000Z', message: undefined,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns quota as null when quota object has no valid windows', () => {
    const result = parseOauthAccountInfo(makeAccount({
      oauthProvider: 'codex',
      extraConfig: JSON.stringify({
        oauth: {
          email: 'u@x.com',
          planType: 'free',
          quota: { status: 'unsupported' },
        },
      }),
    }));
    expect(result).not.toBeNull();
    expect(result!.quota).toBeNull();
  });

  it('handles unsupported window state (supported: false)', () => {
    const result = parseOauthAccountInfo(makeAccount({
      oauthProvider: 'codex',
      extraConfig: JSON.stringify({
        oauth: {
          email: 'u@x.com',
          planType: 'free',
          quota: {
            windows: {
              fiveHour: { supported: false, message: 'N/A' },
              sevenDay: { supported: false },
            },
          },
        },
      }),
    }));
    expect(result).not.toBeNull();
    expect(result!.quota!.fiveHour).toEqual({
      supported: false, used: undefined, limit: undefined, remaining: undefined, resetAt: undefined, message: 'N/A',
    });
    expect(result!.quota!.sevenDay).toEqual({
      supported: false, used: undefined, limit: undefined, remaining: undefined, resetAt: undefined, message: undefined,
    });
  });

  it('handles malformed extraConfig gracefully', () => {
    expect(parseOauthAccountInfo(makeAccount({ extraConfig: '{invalid' }))).toBeNull();
    expect(parseOauthAccountInfo(makeAccount({ extraConfig: '[]' }))).toBeNull();
  });

  it('trims whitespace from provider, email, planType', () => {
    const result = parseOauthAccountInfo(makeAccount({
      oauthProvider: '  codex  ',
      extraConfig: JSON.stringify({
        oauth: { email: '  u@x.com  ', planType: '  go  ' },
      }),
    }));
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('codex');
    expect(result!.email).toBe('u@x.com');
    expect(result!.planType).toBe('go');
  });

  it('still works when provider is set but email and planType are empty', () => {
    const result = parseOauthAccountInfo(makeAccount({
      oauthProvider: 'grok',
      extraConfig: JSON.stringify({ oauth: {} }),
    }));
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('grok');
    expect(result!.email).toBe('');
    expect(result!.planType).toBe('');
    expect(result!.quota).toBeNull();
  });
});

describe('parseSub2ApiAccountUsage', () => {
  const makeSub2ApiAccount = (extraConfig: Record<string, any>) => ({
    id: 1,
    oauthProvider: '',
    extraConfig: JSON.stringify(extraConfig),
  });

  it('returns null when no sub2apiSubscription exists', () => {
    expect(parseSub2ApiAccountUsage(makeSub2ApiAccount({ credentialMode: 'session' }))).toBeNull();
    expect(parseSub2ApiAccountUsage(makeSub2ApiAccount({ sub2apiSubscription: null }))).toBeNull();
    expect(parseSub2ApiAccountUsage(null)).toBeNull();
  });

  it('aggregates plan names, monthly limits, and earliest expiry', () => {
    const usage = parseSub2ApiAccountUsage(makeSub2ApiAccount({
      sub2apiSubscription: {
        activeCount: 2,
        totalUsedUsd: 22.03,
        subscriptions: [
          {
            groupName: 'Grok-选我',
            monthlyLimitUsd: 400,
            expiresAt: '2026-09-02T11:53:25.000Z',
          },
          {
            groupName: 'Claude-Pro',
            monthlyLimitUsd: 100,
            expiresAt: '2026-08-30T00:00:00.000Z',
          },
        ],
        updatedAt: Date.now(),
      },
    }));
    expect(usage).not.toBeNull();
    expect(usage!.planNames).toEqual(['Grok-选我', 'Claude-Pro']);
    expect(usage!.totalUsedUsd).toBe(22.03);
    expect(usage!.totalMonthlyLimitUsd).toBe(500);
    expect(usage!.totalRemainingUsd).toBe(477.97);
    expect(usage!.nextExpiresAt).toBe('2026-08-30T00:00:00.000Z');
    expect(usage!.activeCount).toBe(2);
  });

  it('handles empty subscriptions with only totalUsedUsd', () => {
    const usage = parseSub2ApiAccountUsage(makeSub2ApiAccount({
      sub2apiSubscription: { activeCount: 0, totalUsedUsd: 0, subscriptions: [], updatedAt: Date.now() },
    }));
    expect(usage).not.toBeNull();
    expect(usage!.planNames).toEqual([]);
    expect(usage!.totalUsedUsd).toBe(0);
    expect(usage!.totalMonthlyLimitUsd).toBeNull();
    expect(usage!.totalRemainingUsd).toBeNull();
    expect(formatSub2ApiUsageInline(usage)).toContain('已用$0.00');
  });

  it('formats a full usage label', () => {
    const usage = parseSub2ApiAccountUsage(makeSub2ApiAccount({
      sub2apiSubscription: {
        activeCount: 1,
        totalUsedUsd: 22.028312,
        subscriptions: [
          {
            groupName: 'Grok-选我',
            monthlyLimitUsd: 400,
            expiresAt: '2026-09-02T11:53:25.000Z',
          },
        ],
        updatedAt: Date.now(),
      },
    }));
    const label = formatSub2ApiUsageInline(usage);
    expect(label).toContain('Grok-选我');
    expect(label).toContain('剩余$377.97');
    expect(label).toContain('已用$22.03');
    expect(label).toContain('总额度$400.00');
  });
});
