import { randomUUID } from 'node:crypto';
import { fetch } from 'undici';
import { withExplicitProxyRequestInit } from '../siteProxy.js';
import { createPkceChallenge } from './sessionStore.js';
import type {
  OAuthProviderDefinition,
  OAuthProviderExchangeResult,
  OAuthProviderRefreshResult,
} from './providers.js';

/**
 * 标准 OAuth authorization_code 授权工厂（9router src/lib/oauth/providers/*.js 对齐）。
 * 适用 xai / iflow / trae / clinepass：浏览器打开 authorizeUrl → 回调 code → 换 token。
 */

type AuthCodeProviderInput = {
  provider: string;
  label: string;
  platform: string;
  siteName: string;
  siteUrl: string;
  models: string[];
  modelsUrl?: string;
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  scope?: string;
  /** authorize URL 额外参数（如 iflow 的 loginMethod/type、xai 的 nonce/plan/referrer） */
  extraAuthorizeParams?: (input: { state: string; redirectUri: string; codeChallenge: string }) => Record<string, string>;
  /** token exchange body 附加字段（如 client_secret） */
  extraTokenBody?: (input: { code: string; redirectUri: string; codeVerifier: string }) => Record<string, string>;
  /** token 请求用 JSON body（默认 form） */
  tokenJsonBody?: boolean;
  /** Basic Auth（clientId:clientSecret base64），如 iflow */
  basicAuth?: boolean;
  /** 换 token 后的附加处理（如 iflow 拉 userInfo 拿 apiKey） */
  postExchange?: (
    tokens: Record<string, unknown>,
    proxyUrl?: string | null,
  ) => Promise<Record<string, unknown>>;
  mapExchange?: (
    tokens: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => OAuthProviderExchangeResult;
  /** 转发附加头（buildProxyHeaders） */
  proxyHeaders?: (oauth: Record<string, unknown>) => Record<string, string>;
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
    throw new Error('token exchange response missing access_token');
  }
  const expiresInRaw = tokens.expires_in;
  const expiresIn = typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0
    ? Math.trunc(expiresInRaw)
    : undefined;
  return {
    accessToken,
    ...(asTrimmedString(tokens.refresh_token) ? { refreshToken: asTrimmedString(tokens.refresh_token) } : {}),
    ...(expiresIn ? { tokenExpiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(asTrimmedString(tokens.email) ? { email: asTrimmedString(tokens.email) } : {}),
    ...(Object.keys(extra).length > 0 ? { providerData: extra } : {}),
  };
}

async function exchangeTokenJson(
  input: AuthCodeProviderInput,
  body: Record<string, unknown>,
  proxyUrl?: string | null,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (input.tokenJsonBody) {
    headers['Content-Type'] = 'application/json';
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  if (input.basicAuth) {
    headers.Authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret || ''}`).toString('base64')}`;
  }
  const response = await fetch(input.tokenUrl, withExplicitProxyRequestInit(proxyUrl, {
    method: 'POST',
    headers,
    body: input.tokenJsonBody
      ? JSON.stringify(body)
      : new URLSearchParams(Object.entries(body).filter(([, v]) => v !== undefined && v !== null) as Array<[string, string]>).toString(),
  }));
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `${input.label} token exchange failed with status ${response.status}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

function createAuthCodeOauthProvider(input: AuthCodeProviderInput): OAuthProviderDefinition {
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
    buildAuthorizationUrl: async ({ state, redirectUri, codeVerifier }) => {
      const codeChallenge = await createPkceChallenge(codeVerifier);
      const baseParams: Record<string, string> = {
        response_type: 'code',
        client_id: input.clientId,
        redirect_uri: redirectUri,
        state,
        ...(input.scope ? { scope: input.scope } : {}),
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      };
      const extra = input.extraAuthorizeParams
        ? input.extraAuthorizeParams({ state, redirectUri, codeChallenge })
        : {};
      const params = new URLSearchParams({ ...baseParams, ...extra });
      return `${input.authorizeUrl}?${params.toString()}`;
    },
    exchangeAuthorizationCode: async ({ code, redirectUri, codeVerifier, proxyUrl }) => {
      const extraBody = input.extraTokenBody
        ? input.extraTokenBody({ code, redirectUri, codeVerifier })
        : {};
      const tokens = await exchangeTokenJson(input, {
        grant_type: 'authorization_code',
        client_id: input.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        ...extraBody,
      }, proxyUrl);
      let postExtra: Record<string, unknown> = {};
      if (input.postExchange) {
        postExtra = await input.postExchange(tokens, proxyUrl);
      }
      return mapExchange(tokens, postExtra);
    },
    refreshAccessToken: async ({ refreshToken, proxyUrl }): Promise<OAuthProviderRefreshResult> => {
      if (!input.refreshUrl) {
        throw new Error(`${input.label} 不提供 token 刷新，过期后请重新授权`);
      }
      const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
      if (input.basicAuth) {
        headers.Authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret || ''}`).toString('base64')}`;
      }
      const response = await fetch(input.refreshUrl, withExplicitProxyRequestInit(proxyUrl, {
        method: 'POST',
        headers,
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
    ...(input.proxyHeaders ? {
      buildProxyHeaders: (headersInput: { oauth: Record<string, unknown> }): Record<string, string> => input.proxyHeaders!(headersInput.oauth as Record<string, unknown>),
    } : {}),
  };
}

// ── xAI / Grok OAuth（9router xai.js，PKCE + discovery）─────────────────────

const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

export const xaiOauthProvider = createAuthCodeOauthProvider({
  provider: 'xai',
  label: 'xAI / Grok',
  platform: 'xai',
  siteName: 'xAI (Grok)',
  siteUrl: 'https://api.x.ai/v1',
  models: ['grok-build', 'grok-4.5'],
  clientId: XAI_CLIENT_ID,
  scope: 'openid profile email offline_access grok-cli:access api:access',
  authorizeUrl: 'https://auth.x.ai/oauth2/authorize',
  tokenUrl: 'https://auth.x.ai/oauth2/token',
  refreshUrl: 'https://auth.x.ai/oauth2/token',
  extraAuthorizeParams: () => ({
    nonce: randomUUID().replace(/-/g, ''),
    plan: 'generic',
    referrer: 'cli-proxy-api',
  }),
});

// ── iFlow（9router iflow.js，Basic Auth + userInfo 拿 apiKey）──────────────

export const iflowOauthProvider = createAuthCodeOauthProvider({
  provider: 'iflow',
  label: 'iFlow',
  platform: 'iflow',
  siteName: 'iFlow',
  siteUrl: 'https://apis.iflow.cn/v1',
  models: [
    'qwen3-coder-plus',
    'qwen3-max',
    'qwen3-vl-plus',
    'qwen3-max-preview',
    'qwen3-235b',
    'qwen3-235b-a22b-instruct',
    'qwen3-235b-a22b-thinking-2507',
    'qwen3-32b',
    'kimi-k2',
    'deepseek-v3.2',
    'deepseek-v3.1',
    'deepseek-v3',
    'deepseek-r1',
    'glm-4.7',
    'iflow-rome-30ba3b',
  ],
  clientId: '10009311001',
  clientSecret: '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW',
  scope: 'phone',
  authorizeUrl: 'https://iflow.cn/oauth',
  tokenUrl: 'https://iflow.cn/oauth/token',
  refreshUrl: 'https://iflow.cn/oauth/token',
  extraAuthorizeParams: () => ({ loginMethod: 'phone', type: 'phone' }),
  extraTokenBody: ({ redirectUri }) => ({ client_secret: '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW', redirect_uri: redirectUri }),
  basicAuth: true,
  postExchange: async (tokens) => {
    const accessToken = asTrimmedString(tokens.access_token);
    if (!accessToken) throw new Error('iflow token missing access_token');
    const response = await fetch(
      `https://iflow.cn/api/oauth/getUserInfo?accessToken=${encodeURIComponent(accessToken)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to fetch iFlow user info: ${text}`);
    }
    const result = await response.json() as { success?: unknown; data?: Record<string, unknown> };
    if (result.success !== true) {
      throw new Error('iFlow user info request failed');
    }
    const userInfo = (result.data || {}) as Record<string, unknown>;
    const apiKey = asTrimmedString(userInfo.apiKey);
    if (!apiKey) {
      throw new Error('Empty API key returned from iFlow');
    }
    const email = asTrimmedString(userInfo.email) || asTrimmedString(userInfo.phone);
    if (!email) {
      throw new Error('Missing iFlow account email/phone in user info');
    }
    return { apiKey, iflowEmail: email, nickname: asTrimmedString(userInfo.nickname) || asTrimmedString(userInfo.name) };
  },
  mapExchange: (tokens, extra) => {
    const base = buildStandardExchange(tokens, extra);
    return {
      ...base,
      ...(asTrimmedString(extra.iflowEmail) ? { email: asTrimmedString(extra.iflowEmail) } : {}),
    };
  },
  proxyHeaders: (oauth): Record<string, string> => {
    const apiKey = asTrimmedString(oauth.apiKey);
    if (!apiKey) return {};
    return { 'x-api-key': apiKey };
  },
});

// ── Trae（9router trae.js，GetLoginGuidance → 授权 URL → ExchangeToken）────

const TRAE_CLIENT_ID = 'ono9krqynydwx5';
const TRAE_LOGIN_GUIDANCE_URLS = [
  'https://api.marscode.com/cloudide/api/v3/trae/GetLoginGuidance',
];
const TRAE_EXCHANGE_URLS = [
  'https://api.marscode.com/cloudide/api/v3/trae/oauth/ExchangeToken',
];
const TRAE_USER_INFO_URLS = [
  'https://api.marscode.com/cloudide/api/v3/trae/GetUserInfo',
];
const TRAE_DEVICE_ID = 'e0d7a22c-c7e7-4f5a-8a9b-6b0c1d2e3f40';
const TRAE_USER_AGENT = 'Trae/1.0 (com.trae.ide; build 1.0)';

function extractTraeLoginHost(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const paths: Array<Array<string>> = [
    ['Result', 'LoginHost'],
    ['Result', 'loginHost'],
    ['Result', 'LoginURL'],
    ['result', 'loginHost'],
    ['data', 'Result', 'LoginHost'],
    ['data', 'loginHost'],
    ['LoginHost'],
    ['loginHost'],
  ];
  for (const path of paths) {
    let current: unknown = record;
    let ok = true;
    for (const key of path) {
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        current = (current as Record<string, unknown>)[key];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && typeof current === 'string' && current.trim()) {
      return current.trim();
    }
  }
  return undefined;
}

function extractTraeJsonPath(data: unknown, paths: string[][]): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  for (const path of paths) {
    let current: unknown = data;
    let ok = true;
    for (const key of path) {
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        current = (current as Record<string, unknown>)[key];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && current !== undefined && current !== null) return current;
  }
  return undefined;
}

async function fetchTraeLoginHost(loginTraceId: string): Promise<string> {
  const body = JSON.stringify({ loginTraceID: loginTraceId, login_trace_id: loginTraceId });
  let lastError = 'no successful response';
  for (const url of TRAE_LOGIN_GUIDANCE_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': TRAE_USER_AGENT },
        body,
      });
      if (!res.ok) {
        lastError = `${url} HTTP ${res.status}`;
        continue;
      }
      const data = await res.json();
      const loginHost = extractTraeLoginHost(data);
      if (loginHost) return loginHost;
      lastError = `${url} missing LoginHost`;
    } catch (error) {
      lastError = `${url} ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  throw new Error(`Trae GetLoginGuidance failed: ${lastError}`);
}

function buildTraeVerificationUrl(loginHost: string, loginTraceId: string, callbackUrl: string): string {
  const url = new URL(loginHost.startsWith('http') ? loginHost : `https://${loginHost.replace(/^\/+/, '')}`);
  url.pathname = '/ide/ide_cloudide_auth.html';
  const params = new URLSearchParams({
    login_version: '1',
    auth_from: 'trae',
    login_channel: 'native_ide',
    plugin_version: '1.0.0',
    auth_type: 'local',
    client_id: TRAE_CLIENT_ID,
    redirect: '0',
    login_trace_id: loginTraceId,
    auth_callback_url: callbackUrl,
    machine_id: randomUUID(),
    device_id: TRAE_DEVICE_ID,
    x_device_id: TRAE_DEVICE_ID,
    x_machine_id: randomUUID(),
    x_device_brand: 'unknown',
    x_device_type: 'unknown',
    x_os_version: 'unknown',
    x_env: '',
    x_app_version: '1.0.0',
    x_app_type: 'trae',
  });
  return `${url.origin}${url.pathname}?${params.toString()}`;
}

export const traeOauthProvider: OAuthProviderDefinition = {
  metadata: {
    provider: 'trae',
    label: 'Trae',
    platform: 'trae',
    enabled: true,
    loginType: 'oauth',
    requiresProjectId: false,
    supportsDirectAccountRouting: false,
    supportsCloudValidation: false,
    supportsNativeProxy: false,
    proxySupported: true,
  },
  site: {
    name: 'Trae (ByteDance)',
    url: 'https://core-normal.trae.ai/api/remote/v1',
    platform: 'trae',
  },
  loopback: {
    host: '127.0.0.1',
    port: 0,
    path: '/auth/callback/trae',
    redirectUri: 'http://localhost:0/auth/callback/trae',
  },
  discovery: {
    models: [
      'auto',
      'work',
      'gemini-3.1-pro',
      'gemini-3-flash-solo',
      'minimax-m3',
      'minimax-m2.7',
      'kimi-k2.5',
      'gpt-5.4',
      'gpt-5.2',
    ],
    chatSuffix: '',
    proxySupported: true,
  },
  buildAuthorizationUrl: async ({ state }) => {
    const loginHost = await fetchTraeLoginHost(state);
    return buildTraeVerificationUrl(loginHost, state, 'http://localhost:0/auth/callback/trae');
  },
  exchangeAuthorizationCode: async ({ code, redirectUri }) => {
    const body = JSON.stringify({
      loginTraceID: code,
      login_trace_id: code,
      auth_callback_url: redirectUri,
      plugin_version: '1.0.0',
      device_id: TRAE_DEVICE_ID,
      x_device_id: TRAE_DEVICE_ID,
      machine_id: randomUUID(),
      x_machine_id: randomUUID(),
      x_device_brand: 'unknown',
      x_device_type: 'unknown',
      x_os_version: 'unknown',
      x_app_version: '1.0.0',
      x_app_type: 'trae',
    });
    let lastError = 'no successful response';
    for (const url of TRAE_EXCHANGE_URLS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': TRAE_USER_AGENT },
          body,
        });
        const text = await res.text();
        if (!res.ok) {
          lastError = `${url} HTTP ${res.status}: ${text.slice(0, 200)}`;
          continue;
        }
        const data = JSON.parse(text) as Record<string, unknown>;
        const accessToken = asTrimmedString(
          extractTraeJsonPath(data, [
            ['Result', 'AccessToken'],
            ['Result', 'accessToken'],
            ['result', 'access_token'],
            ['accessToken'],
          ]) as string | undefined,
        );
        if (!accessToken) {
          lastError = `${url} missing AccessToken`;
          continue;
        }
        const refreshToken = asTrimmedString(
          extractTraeJsonPath(data, [
            ['Result', 'RefreshToken'],
            ['result', 'refresh_token'],
            ['refreshToken'],
          ]) as string | undefined,
        );
        const exchange: OAuthProviderExchangeResult = { accessToken };
        if (refreshToken) exchange.refreshToken = refreshToken;
        // 拉取用户信息（尽力而为）
        try {
          const userRes = await fetch(TRAE_USER_INFO_URLS[0]!, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'User-Agent': TRAE_USER_AGENT,
              'x-cloudide-token': accessToken,
            },
            body: JSON.stringify({}),
          });
          if (userRes.ok) {
            const userData = await userRes.json() as Record<string, unknown>;
            const email = asTrimmedString(
              extractTraeJsonPath(userData, [
                ['Result', 'NonPlainTextEmail'],
                ['Result', 'Email'],
                ['Result', 'email'],
                ['result', 'email'],
              ]) as string | undefined,
            );
            if (email) exchange.email = email;
          }
        } catch { /* non-fatal */ }
        return exchange;
      } catch (error) {
        lastError = `${url} ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    throw new Error(`Trae ExchangeToken failed: ${lastError}`);
  },
  refreshAccessToken: async ({ refreshToken }) => {
    // Trae 的 refresh 与 exchange 同端点，用 refresh_token 换新 token（9router 同款）
    const response = await fetch(TRAE_EXCHANGE_URLS[0]!, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': TRAE_USER_AGENT },
      body: JSON.stringify({ refresh_token: refreshToken, grant_type: 'refresh_token', client_id: TRAE_CLIENT_ID }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `Trae token refresh failed with status ${response.status}`);
    }
    const data = await response.json() as Record<string, unknown>;
    const accessToken = asTrimmedString(
      extractTraeJsonPath(data, [['Result', 'AccessToken'], ['accessToken'], ['access_token']]) as string | undefined,
    );
    if (!accessToken) throw new Error('Trae token refresh missing AccessToken');
    const refreshTokenNext = asTrimmedString(
      extractTraeJsonPath(data, [['Result', 'RefreshToken'], ['refreshToken'], ['refresh_token']]) as string | undefined,
    );
    return {
      accessToken,
      ...(refreshTokenNext ? { refreshToken: refreshTokenNext } : {}),
    };
  },
};

// ── ClinePass（9router clinepass.js，共享 cline 端点）───────────────────────

import { decodeBase64TokenCode, exchangeClineToken, parseClineTokenPayload } from './clineProvider.js';

export const clinepassOauthProvider: OAuthProviderDefinition = {
  metadata: {
    provider: 'clinepass',
    label: 'ClinePass',
    platform: 'clinepass',
    enabled: true,
    loginType: 'oauth',
    requiresProjectId: false,
    supportsDirectAccountRouting: false,
    supportsCloudValidation: false,
    supportsNativeProxy: false,
    proxySupported: true,
  },
  site: {
    name: 'ClinePass',
    url: 'https://api.cline.bot/api/v1',
    platform: 'clinepass',
  },
  loopback: {
    host: '127.0.0.1',
    port: 0,
    path: '/auth/callback/clinepass',
    redirectUri: 'http://localhost:0/auth/callback/clinepass',
  },
  discovery: {
    models: [
      'anthropic/claude-opus-4.7',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-opus-4.6',
      'openai/gpt-5.3-codex',
      'openai/gpt-5.4',
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
    return `https://api.cline.bot/api/v1/auth/authorize?${params.toString()}`;
  },
  exchangeAuthorizationCode: async ({ code, redirectUri, proxyUrl }) => {
    const decoded = decodeBase64TokenCode(code);
    if (decoded) return decoded;
    return exchangeClineToken({
      grant_type: 'authorization_code',
      code,
      client_type: 'extension',
      redirect_uri: redirectUri,
    }, proxyUrl);
  },
  refreshAccessToken: async ({ refreshToken, proxyUrl }) => {
    const response = await fetch('https://api.cline.bot/api/v1/auth/refresh', withExplicitProxyRequestInit(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }));
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `ClinePass token refresh failed with status ${response.status}`);
    }
    return parseClineTokenPayload(await response.json());
  },
  buildProxyHeaders: () => ({
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline',
  }),
};
