import { describe, expect, it } from 'vitest';
import { normalizeExtraConfigInput } from './accountsRoutePayloads.js';

describe('normalizeExtraConfigInput', () => {
  it('drops unknown keys (mass-assignment guard)', () => {
    const out = normalizeExtraConfigInput({
      credentialMode: 'session',
      platformUserId: 42,
      passwordCipher: 'attacker-controlled',
      hacked: true,
    });
    expect(out).toEqual({
      credentialMode: 'session',
      platformUserId: 42,
    });
    expect(out?.passwordCipher).toBeUndefined();
    expect(out?.hacked).toBeUndefined();
  });

  it('keeps all legitimate keys', () => {
    const out = normalizeExtraConfigInput({
      credentialMode: 'apikey',
      authenticationMode: 'none',
      platformUserId: 7,
      proxyUrl: 'socks5://127.0.0.1:1080',
      autoRelogin: { username: 'u' },
      newApiManagedAuth: { token: 't' },
      sub2apiAuth: { refreshToken: 'r' },
      oauth: { provider: 'codex' },
      subscriptionSummary: { tier: 'pro' },
      websockets: true,
      siteCascadeDisabled: true,
    });
    expect(out).toEqual({
      credentialMode: 'apikey',
      authenticationMode: 'none',
      platformUserId: 7,
      proxyUrl: 'socks5://127.0.0.1:1080',
      autoRelogin: { username: 'u' },
      newApiManagedAuth: { token: 't' },
      sub2apiAuth: { refreshToken: 'r' },
      oauth: { provider: 'codex' },
      subscriptionSummary: { tier: 'pro' },
      websockets: true,
      siteCascadeDisabled: true,
    });
  });

  it('parses JSON strings and filters them too', () => {
    const out = normalizeExtraConfigInput(
      JSON.stringify({ credentialMode: 'session', evil: 1 }),
    );
    expect(out).toEqual({ credentialMode: 'session' });
  });

  it('handles null / undefined / invalid input', () => {
    expect(normalizeExtraConfigInput(null)).toBeNull();
    expect(normalizeExtraConfigInput(undefined)).toBeUndefined();
    expect(normalizeExtraConfigInput('not-json')).toEqual({});
    expect(normalizeExtraConfigInput(42)).toEqual({});
  });
});
