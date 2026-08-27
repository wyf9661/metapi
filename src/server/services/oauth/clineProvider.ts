import { fetch } from 'undici';
import { withExplicitProxyRequestInit } from '../siteProxy.js';
import type {
  OAuthProviderDefinition,
  OAuthProviderExchangeResult,
  OAuthProviderRefreshResult,
} from './providers.js';

/**
 * Cline — authorization_code 授权（9router src/lib/oauth/providers/cline.js 对齐）。
 *
 * 流程：
 * 1. 浏览器打开 authorizeUrl?client_type=extension&callback_url={redirectUri}&redirect_uri={redirectUri}
 * 2. 授权后 Cline 把 token 数据 base64 编码在回调 code 参数里回传
 * 3. exchange：优先 base64 解码 code 直接拿 token；失败回退 POST tokenExchangeUrl
 *
 * 上游：https://api.cline.bot/api/v1（chat/completions），转发带 HTTP-Referer / X-Title。
 */

const CLINE_AUTHORIZE_URL = 'https://api.cline.bot/api/v1/auth/authorize';
const CLINE_TOKEN_URL = 'https://api.cline.bot/api/v1/auth/token';
const CLINE_REFRESH_URL = 'https://api.cline.bot/api/v1/auth/refresh';
const CLINE_UPSTREAM_BASE_URL = 'https://api.cline.bot/api/v1';

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseExpiresAt(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function parseClineTokenPayload(payload: unknown): OAuthProviderExchangeResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('cline token exchange returned invalid payload');
  }
  const body = payload as {
    access_token?: unknown;
    accessToken?: unknown;
    refresh_token?: unknown;
    refreshToken?: unknown;
    email?: unknown;
    expires_at?: unknown;
    expiresAt?: unknown;
    data?: {
      accessToken?: unknown;
      refreshToken?: unknown;
      expiresAt?: unknown;
      userInfo?: { email?: unknown };
    };
  };
  const accessToken = asTrimmedString(body.access_token)
    || asTrimmedString(body.accessToken)
    || asTrimmedString(body.data?.accessToken);
  if (!accessToken) {
    throw new Error('cline token exchange response missing access token');
  }
  const email = asTrimmedString(body.email) || asTrimmedString(body.data?.userInfo?.email);
  const expiresAt = parseExpiresAt(asTrimmedString(body.expires_at) || asTrimmedString(body.expiresAt) || asTrimmedString(body.data?.expiresAt));
  return {
    accessToken,
    ...(asTrimmedString(body.refresh_token) || asTrimmedString(body.refreshToken) || asTrimmedString(body.data?.refreshToken)
      ? { refreshToken: asTrimmedString(body.refresh_token) || asTrimmedString(body.refreshToken) || asTrimmedString(body.data?.refreshToken) }
      : {}),
    ...(email ? { email } : {}),
    ...(expiresAt ? { tokenExpiresAt: expiresAt } : {}),
  };
}

export function decodeBase64TokenCode(code: string): OAuthProviderExchangeResult | null {
  try {
    let base64 = code;
    const padding = 4 - (base64.length % 4);
    if (padding !== 4) base64 += '='.repeat(padding);
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    const lastBrace = decoded.lastIndexOf('}');
    if (lastBrace === -1) return null;
    const tokenData = JSON.parse(decoded.substring(0, lastBrace + 1)) as {
      token?: unknown;
      access_token?: unknown;
      refresh_token?: unknown;
      email?: unknown;
      firstName?: unknown;
      lastName?: unknown;
      expiresAt?: unknown;
    };
    const accessToken = asTrimmedString(tokenData.token) || asTrimmedString(tokenData.access_token);
    if (!accessToken) return null;
    return {
      accessToken,
      ...(asTrimmedString(tokenData.refresh_token) ? { refreshToken: asTrimmedString(tokenData.refresh_token) } : {}),
      ...(asTrimmedString(tokenData.email) ? { email: asTrimmedString(tokenData.email) } : {}),
      ...(parseExpiresAt(asTrimmedString(tokenData.expiresAt)) ? { tokenExpiresAt: parseExpiresAt(asTrimmedString(tokenData.expiresAt)) } : {}),
      ...(asTrimmedString(tokenData.firstName) || asTrimmedString(tokenData.lastName)
        ? { providerData: {
          ...(asTrimmedString(tokenData.firstName) ? { firstName: asTrimmedString(tokenData.firstName) } : {}),
          ...(asTrimmedString(tokenData.lastName) ? { lastName: asTrimmedString(tokenData.lastName) } : {}),
        } }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function exchangeClineToken(
  body: Record<string, unknown>,
  proxyUrl?: string | null,
): Promise<OAuthProviderExchangeResult> {
  const response = await fetch(CLINE_TOKEN_URL, withExplicitProxyRequestInit(proxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  }));
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `cline token exchange failed with status ${response.status}`);
  }
  return parseClineTokenPayload(await response.json());
}

export const clineOauthProvider: OAuthProviderDefinition = {
  metadata: {
    provider: 'cline',
    label: 'Cline',
    platform: 'cline',
    enabled: true,
    loginType: 'oauth',
    requiresProjectId: false,
    supportsDirectAccountRouting: false,
    supportsCloudValidation: false,
    supportsNativeProxy: false,
    proxySupported: true,
  },
  site: {
    name: 'Cline',
    url: CLINE_UPSTREAM_BASE_URL,
    platform: 'cline',
  },
  loopback: {
    host: '127.0.0.1',
    port: 0,
    path: '/auth/callback/cline',
    redirectUri: 'http://localhost:0/auth/callback/cline',
  },
  discovery: {
    models: [
      'anthropic/claude-opus-4.7',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-opus-4.6',
      'openai/gpt-5.3-codex',
      'openai/gpt-5.4',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.1-flash-lite-preview',
      'kwaipilot/kat-coder-pro',
    ],
    chatSuffix: '/chat/completions',
    proxySupported: true,
  },
  buildAuthorizationUrl: async ({ redirectUri }) => {
    const params = new URLSearchParams({
      client_type: 'extension',
      callback_url: redirectUri,
      redirect_uri: redirectUri,
    });
    return `${CLINE_AUTHORIZE_URL}?${params.toString()}`;
  },
  exchangeAuthorizationCode: async ({ code, redirectUri, proxyUrl }) => {
    // Cline 把 token 数据 base64 编码在 code 参数里，直接解码即可
    const decoded = decodeBase64TokenCode(code);
    if (decoded) return decoded;
    // 回退标准 token exchange
    return exchangeClineToken({
      grant_type: 'authorization_code',
      code,
      client_type: 'extension',
      redirect_uri: redirectUri,
    }, proxyUrl);
  },
  refreshAccessToken: async ({ refreshToken, proxyUrl }): Promise<OAuthProviderRefreshResult> => {
    const response = await fetch(CLINE_REFRESH_URL, withExplicitProxyRequestInit(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }));
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `cline token refresh failed with status ${response.status}`);
    }
    return parseClineTokenPayload(await response.json());
  },
  buildProxyHeaders: () => ({
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline',
  }),
};
