import { describe, expect, it } from 'vitest';
import {
  buildOauthInfoFromAccount,
  buildStoredOauthStateFromAccount,
  getOauthInfoFromAccount,
} from './oauthAccount.js';

describe('oauth account identity helpers', () => {
  it('prefers structured oauth identity columns over extraConfig metadata', () => {
    const oauth = getOauthInfoFromAccount({
      oauthProvider: 'gemini-cli',
      oauthAccountKey: 'structured-user@example.com',
      oauthProjectId: 'structured-project',
      extraConfig: JSON.stringify({
        oauth: {
          provider: 'codex',
          accountKey: 'json-user',
          projectId: 'json-project',
          refreshToken: 'refresh-token',
          quota: { status: 'supported' },
        },
      }),
    });

    expect(oauth).toEqual(expect.objectContaining({
      provider: 'gemini-cli',
      accountId: 'structured-user@example.com',
      accountKey: 'structured-user@example.com',
      projectId: 'structured-project',
      refreshToken: 'refresh-token',
      quota: { status: 'supported' },
    }));
  });

  it('falls back to extraConfig metadata when structured columns are absent', () => {
    const oauth = getOauthInfoFromAccount({
      oauthProvider: null,
      oauthAccountKey: null,
      oauthProjectId: null,
      extraConfig: JSON.stringify({
        oauth: {
          provider: 'codex',
          accountKey: 'json-user',
          projectId: 'json-project',
          refreshToken: 'refresh-token',
        },
      }),
    });

    expect(oauth).toEqual(expect.objectContaining({
      provider: 'codex',
      accountId: 'json-user',
      accountKey: 'json-user',
      projectId: 'json-project',
      refreshToken: 'refresh-token',
    }));
  });

  it('reconstructs oauth runtime state from extraConfig even when identity fields are stripped', () => {
    const oauth = getOauthInfoFromAccount({
      oauthProvider: 'gemini-cli',
      oauthAccountKey: 'structured-user@example.com',
      oauthProjectId: 'structured-project',
      extraConfig: JSON.stringify({
        oauth: {
          email: 'structured-user@example.com',
          refreshToken: 'refresh-token',
          modelDiscoveryStatus: 'healthy',
        },
      }),
    });

    expect(oauth).toEqual(expect.objectContaining({
      provider: 'gemini-cli',
      accountId: 'structured-user@example.com',
      accountKey: 'structured-user@example.com',
      projectId: 'structured-project',
      email: 'structured-user@example.com',
      refreshToken: 'refresh-token',
      modelDiscoveryStatus: 'healthy',
    }));
  });

  it('builds patched oauth state from structured identity columns and current runtime state', () => {
    const oauth = buildOauthInfoFromAccount({
      oauthProvider: 'codex',
      oauthAccountKey: 'structured-account',
      oauthProjectId: 'structured-project',
      extraConfig: JSON.stringify({
        oauth: {
          provider: 'codex',
          refreshToken: 'refresh-token',
          modelDiscoveryStatus: 'healthy',
        },
      }),
    }, {
      quota: { status: 'supported' } as any,
    });

    expect(oauth).toEqual(expect.objectContaining({
      provider: 'codex',
      accountId: 'structured-account',
      accountKey: 'structured-account',
      projectId: 'structured-project',
      refreshToken: 'refresh-token',
      modelDiscoveryStatus: 'healthy',
      quota: { status: 'supported' },
    }));
  });

  it('strips oauth identity fields when preparing persisted extraConfig state', () => {
    const oauth = buildStoredOauthStateFromAccount({
      oauthProvider: 'codex',
      oauthAccountKey: 'structured-account',
      oauthProjectId: 'structured-project',
      extraConfig: JSON.stringify({
        oauth: {
          provider: 'codex',
          accountId: 'json-account',
          accountKey: 'json-account',
          projectId: 'json-project',
          refreshToken: 'refresh-token',
          modelDiscoveryStatus: 'healthy',
        },
      }),
    }, {
      quota: { status: 'supported' } as any,
    });

    expect(oauth).toEqual({
      refreshToken: 'refresh-token',
      modelDiscoveryStatus: 'healthy',
      quota: { status: 'supported' },
    });
  });
});
