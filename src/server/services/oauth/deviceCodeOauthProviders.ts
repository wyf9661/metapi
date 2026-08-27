import { randomUUID } from 'node:crypto';
import { fetch } from 'undici';
import { withExplicitProxyRequestInit } from '../siteProxy.js';
import type {
  OAuthDeviceFlowPollResult,
  OAuthDeviceFlowStartResult,
  OAuthProviderDefinition,
  OAuthProviderExchangeResult,
  OAuthProviderProxyHeaderInput,
} from './providers.js';

/**
 * 标准 OAuth device-code 授权工厂（9router src/lib/oauth/providers/*.js 对齐）。
 * 适用 github / grok-cli / kimi：POST deviceCodeUrl 拿设备码 → 浏览器授权 →
 * 轮询 POST tokenUrl 换 access_token。
 */

type DeviceCodeProviderInput = {
  provider: string;
  label: string;
  platform: string;
  siteName: string;
  siteUrl: string;
  models: string[];
  modelsUrl?: string;
  clientId: string;
  scope: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  /** 额外 device-code 请求参数（如 grok-cli 的 referrer） */
  extraDeviceBody?: Record<string, string>;
  /** 设备标识生成器（如 kimi 的 deviceId，start/poll 必须一致） */
  deviceIdFactory?: () => string;
  /** device-code 请求附加头（动态生成，如 kimi 的 X-Msh-*） */
  deviceHeaders?: (deviceId?: string) => Record<string, string>;
  /** 轮询请求附加头 */
  pollHeaders?: (deviceId?: string) => Record<string, string>;
  /** 成功换 token 后的附加处理（如 github 拉 copilot token、grok 拉 profile） */
  postExchange?: (
    tokens: Record<string, unknown>,
    proxyUrl?: string | null,
  ) => Promise<Record<string, unknown>>;
  /** 组装 exchange result（默认取 access_token/refresh_token/expires_in） */
  mapExchange?: (
    tokens: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => OAuthProviderExchangeResult;
  /** 转发附加头（buildProxyHeaders） */
  proxyHeaders?: (oauth: OAuthProviderProxyHeaderInput['oauth']) => Record<string, string>;
};

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildStandardExchange(
  tokens: Record<string, unknown>,
  extra: Record<string, unknown>,
): OAuthProviderExchangeResult {
  const accessToken = asTrimmedString(tokens.access_token);
  if (!accessToken) {
    throw new Error('device flow token response missing access_token');
  }
  const expiresInRaw = tokens.expires_in;
  const expiresIn = typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0
    ? Math.trunc(expiresInRaw)
    : undefined;
  return {
    accessToken,
    ...(asTrimmedString(tokens.refresh_token) ? { refreshToken: asTrimmedString(tokens.refresh_token) } : {}),
    ...(expiresIn ? { tokenExpiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(asTrimmedString(tokens.id_token) ? { idToken: asTrimmedString(tokens.id_token) } : {}),
    ...(asTrimmedString(tokens.email) ? { email: asTrimmedString(tokens.email) } : {}),
    ...(Object.keys(extra).length > 0 ? { providerData: extra } : {}),
  };
}

async function requestDeviceCodeJson(
  input: DeviceCodeProviderInput,
  proxyUrl?: string | null,
  deviceId?: string,
): Promise<Record<string, unknown>> {
  const bodyParams: Record<string, string> = {
    client_id: input.clientId,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.extraDeviceBody || {}),
  };
  const body = new URLSearchParams(bodyParams);
  const response = await fetch(input.deviceCodeUrl, withExplicitProxyRequestInit(proxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...(input.deviceHeaders ? input.deviceHeaders(deviceId) : {}),
    },
    body: body.toString(),
  }));
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${input.label} device code request failed: ${text || response.status}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

async function pollDeviceTokenJson(
  input: DeviceCodeProviderInput,
  deviceCode: string,
  proxyUrl?: string | null,
  deviceId?: string,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const response = await fetch(input.tokenUrl, withExplicitProxyRequestInit(proxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...(input.pollHeaders ? input.pollHeaders(deviceId) : {}),
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: input.clientId,
    }).toString(),
  }));
  let data: Record<string, unknown>;
  try {
    data = await response.json() as Record<string, unknown>;
  } catch {
    const text = await response.text().catch(() => '');
    data = { error: 'invalid_response', error_description: text };
  }
  return { ok: response.ok, data };
}

function createDeviceCodeOauthProvider(input: DeviceCodeProviderInput): OAuthProviderDefinition {
  const NOT_SUPPORTED = '此平台不支持浏览器授权，请使用「新建连接」按设备码提示完成授权';

  const mapExchange = input.mapExchange ?? ((tokens, extra) => buildStandardExchange(tokens, extra));

  return {
    metadata: {
      provider: input.provider as never,
      label: input.label,
      platform: input.platform,
      enabled: true,
      loginType: 'oauth',
      requiresProjectId: false,
      supportsDirectAccountRouting: false,
      supportsCloudValidation: false,
      supportsNativeProxy: false,
      proxySupported: true,
    },
    site: {
      name: input.siteName,
      url: input.siteUrl,
      platform: input.platform,
    },
    loopback: {
      host: '127.0.0.1',
      port: 0,
      path: `/auth/callback/${input.platform}`,
      redirectUri: `http://localhost:0/auth/callback/${input.platform}`,
    },
    discovery: {
      modelsUrl: input.modelsUrl,
      models: input.models,
      chatSuffix: '/chat/completions',
      proxySupported: true,
    },
    buildAuthorizationUrl: async () => {
      throw new Error(NOT_SUPPORTED);
    },
    exchangeAuthorizationCode: async () => {
      throw new Error(NOT_SUPPORTED);
    },
    refreshAccessToken: async ({ refreshToken, proxyUrl }) => {
      if (!input.refreshUrl) {
        throw new Error(`${input.label} 不提供 token 刷新，过期后请重新授权`);
      }
      const response = await fetch(input.refreshUrl, withExplicitProxyRequestInit(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: input.clientId,
        }).toString(),
      }));
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `${input.label} token refresh failed with status ${response.status}`);
      }
      return mapExchange(await response.json() as Record<string, unknown>, {});
    },
    ...(input.proxyHeaders ? { buildProxyHeaders: (headersInput: OAuthProviderProxyHeaderInput) => input.proxyHeaders!(headersInput.oauth) } : {}),
    startDeviceFlow: async ({ proxyUrl }): Promise<OAuthDeviceFlowStartResult> => {
      const deviceId = input.deviceIdFactory ? input.deviceIdFactory() : undefined;
      const data = await requestDeviceCodeJson(input, proxyUrl, deviceId);
      const deviceCode = asTrimmedString(data.device_code);
      if (!deviceCode) {
        throw new Error(`${input.label} device code initiation returned no device_code`);
      }
      const userCode = asTrimmedString(data.user_code) || deviceCode;
      const verificationUri = asTrimmedString(data.verification_uri_complete)
        || asTrimmedString(data.verification_uri)
        || input.siteUrl;
      const expiresInRaw = data.expires_in;
      const expiresIn = typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0
        ? Math.trunc(expiresInRaw)
        : 300;
      const intervalRaw = data.interval;
      const interval = typeof intervalRaw === 'number' && Number.isFinite(intervalRaw) && intervalRaw > 0
        ? Math.trunc(intervalRaw)
        : 5;
      return {
        deviceCode,
        userCode,
        verificationUri,
        expiresIn,
        interval,
        ...(deviceId ? { extra: { deviceId } } : {}),
      };
    },
    pollDeviceFlow: async ({ deviceCode, proxyUrl, extra }): Promise<OAuthDeviceFlowPollResult> => {
      const flowExtra = extra || {};
      const deviceId = asTrimmedString(flowExtra.deviceId)
        || (input.deviceIdFactory ? input.deviceIdFactory() : undefined);
      const { ok, data } = await pollDeviceTokenJson(input, deviceCode, proxyUrl, deviceId);
      const error = asTrimmedString(data.error);
      if (ok && asTrimmedString(data.access_token)) {
        let postExtra: Record<string, unknown> = { ...flowExtra };
        if (input.postExchange) {
          try {
            postExtra = { ...postExtra, ...(await input.postExchange(data, proxyUrl)) };
          } catch {
            // postExchange 失败不阻塞授权结果
          }
        }
        return { status: 'approved', exchange: mapExchange(data, postExtra) };
      }
      if (error === 'authorization_pending' || error === 'slow_down' || !ok) {
        if (error === 'slow_down') {
          // 轮询太频繁，仍视为 pending
        }
        return { status: 'pending' };
      }
      if (error === 'expired_token' || error === 'authorization_expired') {
        return { status: 'expired', error: `${input.label} 设备码已过期，请重新发起授权` };
      }
      if (error === 'access_denied') {
        return { status: 'denied', error: `用户在 ${input.label} 拒绝了授权` };
      }
      return { status: 'pending' };
    },
  };
}

// ── GitHub Copilot（9router github.js）─────────────────────────────────────

export const githubOauthProvider = createDeviceCodeOauthProvider({
  provider: 'github',
  label: 'GitHub Copilot',
  platform: 'github',
  siteName: 'GitHub Copilot',
  siteUrl: 'https://api.githubcopilot.com',
  models: [
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.4-mini',
    'claude-haiku-4.5',
    'claude-opus-4.5',
    'claude-sonnet-4.5',
    'claude-sonnet-4.6',
    'claude-opus-4.6',
    'claude-opus-4.7',
    'gemini-2.5-pro',
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
  ],
  clientId: 'Iv1.b507a08c87ecfe98',
  scope: 'read:user',
  deviceCodeUrl: 'https://github.com/login/device/code',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  refreshUrl: 'https://github.com/login/oauth/access_token',
  postExchange: async (tokens) => {
    const headers = {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
    };
    const extra: Record<string, unknown> = {};
    try {
      const copilotRes = await fetch('https://api.github.com/copilot_internal/v2/token', { headers });
      if (copilotRes.ok) {
        const copilot = await copilotRes.json() as { token?: unknown; expires_at?: unknown };
        extra.copilotToken = copilot.token;
        extra.copilotTokenExpiresAt = copilot.expires_at;
      }
    } catch { /* non-fatal */ }
    try {
      const userRes = await fetch('https://api.github.com/user', { headers });
      if (userRes.ok) {
        const user = await userRes.json() as { login?: unknown; id?: unknown; name?: unknown; email?: unknown };
        extra.githubUserId = user.id;
        extra.githubLogin = user.login;
        extra.githubName = user.name;
        extra.githubEmail = user.email;
      }
    } catch { /* non-fatal */ }
    return extra;
  },
  mapExchange: (tokens, extra) => {
    const base = buildStandardExchange(tokens, extra);
    return {
      ...base,
      ...(asTrimmedString(extra.githubEmail) ? { email: asTrimmedString(extra.githubEmail) } : {}),
    };
  },
  proxyHeaders: (oauth): Record<string, string> => {
    const copilotToken = asTrimmedString(
      (oauth.providerData as Record<string, unknown> | undefined)?.copilotToken,
    );
    if (!copilotToken) return {};
    return {
      'Authorization': `Bearer ${copilotToken}`,
      'copilot-integration-id': 'vscode-chat',
      'editor-version': 'vscode/1.85.0',
      'editor-plugin-version': 'copilot-chat/0.26.7',
      'user-agent': 'GitHubCopilotChat/0.26.7',
      'openai-intent': 'conversation-panel',
      'x-github-api-version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  },
});

// ── Grok CLI / Grok Build（9router grok-cli.js，auth.x.ai device flow）──────

export const grokCliOauthProvider = createDeviceCodeOauthProvider({
  provider: 'grok',
  label: 'Grok CLI',
  platform: 'grok',
  siteName: 'Grok CLI / xAI',
  siteUrl: 'https://cli-chat-proxy.grok.com/v1',
  modelsUrl: 'https://cli-chat-proxy.grok.com/v1/models',
  models: ['grok-build'],
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  scope: 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write',
  deviceCodeUrl: 'https://auth.x.ai/oauth2/device/code',
  tokenUrl: 'https://auth.x.ai/oauth2/token',
  refreshUrl: 'https://auth.x.ai/oauth2/token',
  extraDeviceBody: { referrer: 'grok-build' },
  postExchange: async (tokens) => {
    try {
      const res = await fetch('https://cli-chat-proxy.grok.com/v1/user', {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: 'application/json',
          'User-Agent': 'grok-pager/0.2.93 grok-shell/0.2.93 (linux; x86_64)',
          'x-xai-token-auth': 'xai-grok-cli',
          'x-grok-client-version': '0.2.93',
        },
      });
      if (res.ok) {
        const user = await res.json() as { email?: unknown; userId?: unknown; principalId?: unknown; firstName?: unknown; lastName?: unknown };
        return {
          grokUserEmail: user.email,
          grokUserId: user.userId ?? user.principalId,
          grokDisplayName: [user.firstName, user.lastName].filter(Boolean).join(' '),
        };
      }
    } catch { /* non-fatal */ }
    return {};
  },
  mapExchange: (tokens, extra) => {
    const base = buildStandardExchange(tokens, extra);
    return {
      ...base,
      ...(asTrimmedString(extra.grokUserEmail) ? { email: asTrimmedString(extra.grokUserEmail) } : {}),
    };
  },
  proxyHeaders: (_oauth): Record<string, string> => ({
    'x-grok-client-identifier': 'grok-shell',
    'x-grok-client-version': '0.2.93',
    'x-xai-token-auth': 'xai-grok-cli',
  }),
});

// ── Kimi Code（9router kimi.js，device flow + X-Msh-* 头）──────────────────

function buildKimiHeaders(deviceId: string): Record<string, string> {
  return {
    'X-Msh-Platform': 'metapi',
    'X-Msh-Version': '1.0.0',
    'X-Msh-Device-Name': 'metapi-server',
    'X-Msh-Device-Model': 'Linux x86_64',
    'X-Msh-Device-Id': deviceId,
  };
}

export const kimiOauthProvider = createDeviceCodeOauthProvider({
  provider: 'kimi',
  label: 'Kimi',
  platform: 'kimi',
  siteName: 'Kimi Code',
  siteUrl: 'https://api.kimi.com/coding/v1',
  models: [
    'kimi-k3',
    'k3',
    'kimi-for-coding',
    'kimi-for-coding-highspeed',
    'kimi-k2.7-code',
    'kimi-k2.7-code-highspeed',
    'kimi-k2.6',
    'kimi-k2.5',
    'kimi-k2.5-thinking',
    'kimi-latest',
  ],
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
  scope: '',
  deviceCodeUrl: 'https://auth.kimi.com/api/oauth/device_authorization',
  tokenUrl: 'https://auth.kimi.com/api/oauth/token',
  refreshUrl: 'https://auth.kimi.com/api/oauth/token',
  deviceIdFactory: () => randomUUID(),
  deviceHeaders: (deviceId) => buildKimiHeaders(deviceId || ''),
  pollHeaders: (deviceId) => buildKimiHeaders(deviceId || ''),
  proxyHeaders: (oauth) => {
    const deviceId = asTrimmedString(
      (oauth.providerData as Record<string, unknown> | undefined)?.deviceId,
    );
    return deviceId ? buildKimiHeaders(deviceId) : {};
  },
});
