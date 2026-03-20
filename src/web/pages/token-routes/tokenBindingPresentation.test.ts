import { describe, expect, it } from 'vitest';
import {
  buildFixedTokenOptionDescription,
  buildFixedTokenOptionLabel,
  describeTokenBinding,
  resolveTokenBindingConnectionMode,
} from './tokenBindingPresentation.js';

describe('tokenBindingPresentation', () => {
  it('describes follow-account-default mode with the current default token', () => {
    const result = describeTokenBinding([
      { id: 1, name: 'token-a', isDefault: true },
      { id: 2, name: 'token-b', isDefault: false },
    ], 0);

    expect(result.bindingModeLabel).toBe('跟随账号默认');
    expect(result.badgeTone).toBe('info');
    expect(result.effectiveTokenName).toBe('token-a');
    expect(result.helperText).toContain('以后账号默认变化时会自动切换');
    expect(result.followOptionLabel).toBe('跟随账号默认');
    expect(result.followOptionDescription).toContain('当前生效：token-a');
  });

  it('describes fixed mode when the selected token is also the account default', () => {
    const result = describeTokenBinding([
      { id: 1, name: 'default', isDefault: true },
      { id: 2, name: 'backup', isDefault: false },
    ], 1);

    expect(result.bindingModeLabel).toBe('固定令牌');
    expect(result.badgeTone).toBe('warning');
    expect(result.effectiveTokenName).toBe('default');
    expect(result.helperText).toContain('它目前也是账号默认');
    expect(result.helperText).toContain('不会跟着变');
  });

  it('describes fixed mode when the selected token is not the account default', () => {
    const result = describeTokenBinding([
      { id: 1, name: 'default', isDefault: true },
      { id: 2, name: 'backup', isDefault: false },
    ], 2);

    expect(result.bindingModeLabel).toBe('固定令牌');
    expect(result.badgeTone).toBe('warning');
    expect(result.effectiveTokenName).toBe('backup');
    expect(result.helperText).toContain('不会随账号默认变化');
    expect(result.followOptionLabel).toBe('跟随账号默认');
  });

  it('describes follow-account-default mode when no default token exists yet', () => {
    const result = describeTokenBinding([
      { id: 2, name: 'backup', isDefault: false },
      { id: 3, name: 'spare', isDefault: false },
    ], 0);

    expect(result.bindingModeLabel).toBe('跟随账号默认');
    expect(result.badgeTone).toBe('info');
    expect(result.effectiveTokenName).toBe('未设置默认令牌');
    expect(result.helperText).toContain('当前账号还没有默认令牌');
    expect(result.followOptionLabel).toBe('跟随账号默认');
    expect(result.followOptionDescription).toContain('以后账号默认变化时会自动切换');
  });

  it('describes follow-api-setting mode for direct apikey connections', () => {
    const result = describeTokenBinding([], 0, null, {
      connectionMode: 'apikey',
      accountName: 'elysiver_api',
    });

    expect(result.bindingModeLabel).toBe('API令牌');
    expect(result.badgeTone).toBe('warning');
    expect(result.isFollowingAccountDefault).toBe(false);
    expect(result.effectiveTokenName).toBe('elysiver_api');
    expect(result.helperText).toContain('连接「elysiver_api」保存的 API Key');
    expect(result.followOptionLabel).toBe('固定使用：elysiver_api(跟随 API Key 设置)');
    expect(result.followOptionDescription).toContain('API Key');
  });

  it('describes oauth direct binding without default-token wording', () => {
    const result = describeTokenBinding([], 0, null, {
      connectionMode: 'oauth',
      accountName: 'mail@urlk.cn',
    });

    expect(result.bindingModeLabel).toBe('OAuth授权');
    expect(result.badgeTone).toBe('warning');
    expect(result.isFollowingAccountDefault).toBe(false);
    expect(result.effectiveTokenName).toBe('mail@urlk.cn');
    expect(result.helperText).toContain('OAuth 授权');
    expect(result.helperText).not.toContain('默认令牌');
    expect(result.followOptionLabel).toBe('固定使用：mail@urlk.cn(OAuth 授权)');
    expect(result.followOptionDescription).toContain('OAuth 授权');
  });

  it('uses oauth fallback copy when a fixed token route is switched back to oauth direct binding', () => {
    const result = describeTokenBinding([
      { id: 1, name: 'default', isDefault: true },
      { id: 2, name: 'backup', isDefault: false },
    ], 2, null, {
      connectionMode: 'oauth',
      accountName: 'mail@urlk.cn',
    });

    expect(result.bindingModeLabel).toBe('固定令牌');
    expect(result.followOptionLabel).toBe('OAuth授权');
    expect(result.followOptionDescription).toContain('mail@urlk.cn');
    expect(result.followOptionDescription).not.toContain('当前生效：default');
  });

  it('resolves token binding connection mode from stored account fields', () => {
    expect(resolveTokenBindingConnectionMode({
      accessToken: '',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    })).toBe('apikey');

    expect(resolveTokenBindingConnectionMode({
      accessToken: 'session-token',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    })).toBe('session');

    expect(resolveTokenBindingConnectionMode({
      accessToken: 'oauth-access-token',
      extraConfig: JSON.stringify({ credentialMode: 'session', oauth: { provider: 'codex' } }),
    })).toBe('oauth');
  });

  it('formats fixed token options with clearer labels and descriptions', () => {
    const token = {
      id: 3,
      name: 'shared-token',
      isDefault: true,
      sourceModel: 'gpt-4o-mini',
    };

    expect(buildFixedTokenOptionLabel(token, {
      includeDefaultTag: true,
      includeSourceModel: true,
    })).toBe('固定使用：shared-token（当前账号默认） [gpt-4o-mini]');
    expect(buildFixedTokenOptionDescription(token)).toContain('以后不会自动跟随');
  });
});
