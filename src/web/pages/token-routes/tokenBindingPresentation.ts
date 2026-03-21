export type TokenBindingOption = {
  id: number;
  name: string;
  isDefault: boolean;
  sourceModel?: string;
};

export type TokenBindingPresentation = {
  isFollowingAccountDefault: boolean;
  bindingModeLabel: string;
  badgeTone: 'info' | 'warning';
  effectiveTokenName: string;
  helperText: string;
  followOptionLabel: string;
  followOptionDescription: string;
};

type TokenBindingConnectionMode = 'session' | 'apikey' | 'oauth';

type TokenBindingContext = {
  connectionMode?: TokenBindingConnectionMode;
  accountName?: string | null;
};

function parseExtraConfigHints(extraConfig?: string | null): {
  credentialMode: Extract<TokenBindingConnectionMode, 'session' | 'apikey'> | null;
  hasOauthProvider: boolean;
} {
  if (typeof extraConfig !== 'string' || !extraConfig.trim()) {
    return {
      credentialMode: null,
      hasOauthProvider: false,
    };
  }
  try {
    const parsed = JSON.parse(extraConfig) as {
      credentialMode?: unknown;
      oauth?: { provider?: unknown } | null;
    };
    const raw = String(parsed?.credentialMode || '').trim().toLowerCase();
    return {
      credentialMode: raw === 'session' || raw === 'apikey' ? raw : null,
      hasOauthProvider: typeof parsed?.oauth?.provider === 'string' && parsed.oauth.provider.trim().length > 0,
    };
  } catch {}
  return {
    credentialMode: null,
    hasOauthProvider: false,
  };
}

function buildDirectBindingPresentation(
  connectionMode: Extract<TokenBindingConnectionMode, 'apikey' | 'oauth'>,
  accountName: string,
): TokenBindingPresentation {
  if (connectionMode === 'oauth') {
    return {
      isFollowingAccountDefault: false,
      bindingModeLabel: 'OAuth授权',
      badgeTone: 'warning',
      effectiveTokenName: accountName,
      helperText: `当前直接使用连接「${accountName}」的 OAuth 授权，不依赖账号令牌。`,
      followOptionLabel: `固定使用：${accountName}(OAuth 授权)`,
      followOptionDescription: `直接使用连接「${accountName}」的 OAuth 授权`,
    };
  }

  return {
    isFollowingAccountDefault: false,
    bindingModeLabel: 'API令牌',
    badgeTone: 'warning',
    effectiveTokenName: accountName,
    helperText: `当前直接使用连接「${accountName}」保存的 API Key，不依赖账号令牌。`,
    followOptionLabel: `固定使用：${accountName}(跟随 API Key 设置)`,
    followOptionDescription: `直接使用连接「${accountName}」保存的 API Key`,
  };
}

export function resolveTokenBindingConnectionMode(account?: {
  accessToken?: string | null;
  extraConfig?: string | null;
  credentialMode?: string | null;
} | null): TokenBindingConnectionMode {
  const parsedHints = parseExtraConfigHints(account?.extraConfig);
  if (parsedHints.hasOauthProvider) return 'oauth';

  const rawMode = String(account?.credentialMode || '').trim().toLowerCase();
  if (rawMode === 'session') return 'session';
  if (rawMode === 'apikey') return 'apikey';

  if (parsedHints.credentialMode) return parsedHints.credentialMode;

  return typeof account?.accessToken === 'string' && account.accessToken.trim()
    ? 'session'
    : 'apikey';
}

export function getDefaultTokenOption(options: TokenBindingOption[]): TokenBindingOption | null {
  return options.find((option) => option.isDefault) || null;
}

export function describeTokenBinding(
  options: TokenBindingOption[],
  activeTokenId: number,
  fallbackTokenName?: string | null,
  context: TokenBindingContext = {},
): TokenBindingPresentation {
  const defaultToken = getDefaultTokenOption(options);
  const selectedToken = activeTokenId
    ? options.find((option) => option.id === activeTokenId) || null
    : null;
  const connectionMode = context.connectionMode || 'session';
  const accountName = String(context.accountName || '').trim() || '当前连接';

  if (!activeTokenId) {
    if (connectionMode === 'apikey' || connectionMode === 'oauth') {
      return buildDirectBindingPresentation(connectionMode, accountName);
    }

    const effectiveTokenName = defaultToken?.name || fallbackTokenName || '未设置默认令牌';
    return {
      isFollowingAccountDefault: true,
      bindingModeLabel: '跟随账号默认',
      badgeTone: 'info',
      effectiveTokenName,
      helperText: defaultToken
        ? `跟随账号默认。当前生效的是「${defaultToken.name}」，以后账号默认变化时会自动切换。`
        : '跟随账号默认。当前账号还没有默认令牌。',
      followOptionLabel: '跟随账号默认',
      followOptionDescription: defaultToken
        ? `当前生效：${defaultToken.name}；以后账号默认变化时会自动切换`
        : '以后账号默认变化时会自动切换',
    };
  }

  const effectiveTokenName = selectedToken?.name || fallbackTokenName || `token-${activeTokenId}`;
  return {
    isFollowingAccountDefault: false,
    bindingModeLabel: '固定令牌',
    badgeTone: 'warning',
    effectiveTokenName,
    helperText: selectedToken?.isDefault
      ? `已固定到「${effectiveTokenName}」。它目前也是账号默认，但以后账号默认变化时，这个通道不会跟着变。`
      : `已固定到「${effectiveTokenName}」，不会随账号默认变化。`,
    followOptionLabel: connectionMode === 'oauth'
      ? 'OAuth授权'
      : (connectionMode === 'apikey' ? 'API 设置' : '跟随账号默认'),
    followOptionDescription: connectionMode === 'oauth'
      ? `直接使用连接「${accountName}」的 OAuth 授权`
      : (connectionMode === 'apikey'
          ? `直接使用连接「${accountName}」保存的 API Key`
          : (defaultToken
              ? `当前生效：${defaultToken.name}；以后账号默认变化时会自动切换`
              : '以后账号默认变化时会自动切换')),
  };
}

export function buildFixedTokenOptionLabel(
  token: TokenBindingOption,
  options: {
    includeDefaultTag?: boolean;
    includeSourceModel?: boolean;
  } = {},
): string {
  let label = `固定使用：${token.name}`;
  if (options.includeDefaultTag && token.isDefault) {
    label += '（当前账号默认）';
  }
  if (options.includeSourceModel && token.sourceModel) {
    label += ` [${token.sourceModel}]`;
  }
  return label;
}

export function buildFixedTokenOptionDescription(token: TokenBindingOption): string {
  return token.isDefault
    ? '固定到这条令牌；它目前也是账号默认，但以后不会自动跟随'
    : '固定到这条令牌；不随账号默认变化';
}
