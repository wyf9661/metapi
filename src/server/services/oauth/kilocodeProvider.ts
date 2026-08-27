import { fetch } from 'undici';
import { withExplicitProxyRequestInit } from '../siteProxy.js';
import type {
  OAuthDeviceFlowPollResult,
  OAuthDeviceFlowStartResult,
  OAuthProviderDefinition,
  OAuthProviderExchangeResult,
} from './providers.js';

/**
 * KiloCode — device-code 授权（9router src/lib/oauth/providers/kilocode.js 对齐）。
 *
 * 流程：
 * 1. POST https://api.kilo.ai/api/device-auth/codes → { code, verificationUrl, expiresIn }
 *    （device_code 与 user_code 相同，都是 code）
 * 2. 轮询 GET https://api.kilo.ai/api/device-auth/codes/{code}
 *    202 = 等待授权；403 = 拒绝；410 = 过期；approved + token = 成功
 * 3. 成功后 GET https://api.kilo.ai/api/profile → organizations[0].id 作为 orgId，
 *    转发时注入 X-Kilocode-OrganizationID（9router kilocodeOrg hook）。
 */

const KILOCODE_OAUTH_BASE_URL = 'https://api.kilo.ai';
const KILOCODE_INITIATE_URL = 'https://api.kilo.ai/api/device-auth/codes';
const KILOCODE_POLL_URL_BASE = 'https://api.kilo.ai/api/device-auth/codes';
const KILOCODE_UPSTREAM_BASE_URL = 'https://api.kilo.ai/api/openrouter';
const KILOCODE_POLL_INTERVAL_S = 3;
const KILOCODE_DEFAULT_EXPIRES_S = 300;

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export const kilocodeOauthProvider: OAuthProviderDefinition = {
  metadata: {
    provider: 'kilocode',
    label: 'KiloCode',
    platform: 'kilocode',
    enabled: true,
    loginType: 'oauth',
    requiresProjectId: false,
    supportsDirectAccountRouting: false,
    supportsCloudValidation: false,
    supportsNativeProxy: false,
    proxySupported: true,
  },
  site: {
    name: 'KiloCode',
    url: KILOCODE_UPSTREAM_BASE_URL,
    platform: 'kilocode',
  },
  loopback: {
    host: '127.0.0.1',
    port: 0,
    path: '/auth/callback/kilocode',
    redirectUri: 'http://localhost:0/auth/callback/kilocode',
  },
  discovery: {
    modelsUrl: 'https://api.kilo.ai/api/gateway/models',
    models: [
      'anthropic/claude-sonnet-4-20250514',
      'anthropic/claude-opus-4-20250514',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'openai/gpt-4.1',
      'openai/o3',
      'deepseek/deepseek-chat',
      'deepseek/deepseek-reasoner',
    ],
    chatSuffix: '/chat/completions',
    proxySupported: true,
  },
  buildAuthorizationUrl: async () => {
    throw new Error('此平台使用设备码授权（device-code），请使用「新建连接」并按照设备码提示完成授权');
  },
  exchangeAuthorizationCode: async () => {
    throw new Error('此平台使用设备码授权（device-code），不适用授权码回调');
  },
  refreshAccessToken: async () => {
    throw new Error('KiloCode 不提供 token 刷新接口，过期后请重新授权');
  },
  buildProxyHeaders: (input): Record<string, string> => {
    const orgId = asTrimmedString(
      (input.oauth.providerData as Record<string, unknown> | undefined)?.orgId,
    );
    if (!orgId) return {};
    return { 'X-Kilocode-OrganizationID': orgId };
  },
  startDeviceFlow: async (input): Promise<OAuthDeviceFlowStartResult> => {
    const response = await fetch(
      KILOCODE_INITIATE_URL,
      withExplicitProxyRequestInit(input.proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 429) {
        throw new Error('KiloCode 待授权的设备码过多，请稍后再试');
      }
      throw new Error(`KiloCode device auth initiation failed: ${text || response.status}`);
    }
    const data = await response.json() as {
      code?: unknown;
      verificationUrl?: unknown;
      expiresIn?: unknown;
    };
    const deviceCode = asTrimmedString(data.code);
    if (!deviceCode) {
      throw new Error('KiloCode device auth initiation returned no code');
    }
    const verificationUri = asTrimmedString(data.verificationUrl) || KILOCODE_OAUTH_BASE_URL;
    const expiresInRaw = data.expiresIn;
    const expiresIn = typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0
      ? Math.trunc(expiresInRaw)
      : KILOCODE_DEFAULT_EXPIRES_S;
    return {
      deviceCode,
      userCode: deviceCode,
      verificationUri,
      expiresIn,
      interval: KILOCODE_POLL_INTERVAL_S,
    };
  },
  pollDeviceFlow: async (input): Promise<OAuthDeviceFlowPollResult> => {
    const response = await fetch(
      `${KILOCODE_POLL_URL_BASE}/${encodeURIComponent(input.deviceCode)}`,
      withExplicitProxyRequestInit(input.proxyUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }),
    );
    if (response.status === 202) {
      return { status: 'pending' };
    }
    if (response.status === 403) {
      return { status: 'denied', error: '用户在 KiloCode 拒绝了授权' };
    }
    if (response.status === 410) {
      return { status: 'expired', error: 'KiloCode 设备码已过期，请重新发起授权' };
    }
    if (!response.ok) {
      return { status: 'error', error: `KiloCode 设备码轮询失败（HTTP ${response.status}）` };
    }
    const data = await response.json() as {
      status?: unknown;
      token?: unknown;
      userEmail?: unknown;
    };
    if (String(data.status || '').toLowerCase() !== 'approved' || !asTrimmedString(data.token)) {
      return { status: 'pending' };
    }
    const accessToken = asTrimmedString(data.token)!;

    // 拉取组织 ID，转发时注入 X-Kilocode-OrganizationID（9router kilocodeOrg hook）
    let orgId: string | undefined;
    try {
      const profileResponse = await fetch(
        `${KILOCODE_OAUTH_BASE_URL}/api/profile`,
        withExplicitProxyRequestInit(input.proxyUrl, {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        }),
      );
      if (profileResponse.ok) {
        const profile = await profileResponse.json() as { organizations?: Array<{ id?: unknown }> };
        orgId = asTrimmedString(profile.organizations?.[0]?.id);
      }
    } catch {
      // profile 拉取失败不影响授权结果
    }

    const exchange: OAuthProviderExchangeResult = {
      accessToken,
      email: asTrimmedString(data.userEmail),
      ...(orgId ? { providerData: { orgId } } : {}),
    };
    return { status: 'approved', exchange };
  },
};
