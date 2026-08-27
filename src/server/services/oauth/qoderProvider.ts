import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fetch, type RequestInit as UndiciRequestInit } from 'undici';
import type {
  OAuthDeviceFlowPollResult,
  OAuthDeviceFlowStartResult,
  OAuthProviderDefinition,
} from './providers.js';

/**
 * Qoder — 自定义 device flow（9router src/lib/oauth/services/qoder.js 对齐）。
 *
 * 与标准 device flow 不同：
 * 1. 本地生成 PKCE verifier/challenge + nonce + machine_id
 * 2. 用户浏览器打开 qoder.com/device/selectAccounts?challenge&nonce&machine_id
 * 3. 轮询 GET openapi.qoder.sh/api/v1/deviceToken/poll?nonce&verifier → dt-... token
 *
 * 注意：qoder 的推理端点（api3.qoder.sh）需要 COSY 签名协议，MetAPI 代理
 * 无法直通，转发标 proxySupported=false（9router 有专属 COSY 实现）。
 */

const QODER_LOGIN_URL = 'https://qoder.com/device/selectAccounts';
const QODER_DEVICE_TOKEN_URL = 'https://openapi.qoder.sh/api/v1/deviceToken/poll';
const QODER_USERINFO_URL = 'https://openapi.qoder.sh/api/v1/userinfo';
const QODER_FETCH_TIMEOUT_MS = 15_000;

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseQoderExpiry(expiresAt: unknown, expiresInSeconds: unknown): number {
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt;
  if (typeof expiresAt === 'string') {
    const trimmed = expiresAt.trim();
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number.parseInt(trimmed, 10);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds) && expiresInSeconds >= 0) {
    return Date.now() + expiresInSeconds * 1000;
  }
  return Date.now() + 30 * 24 * 60 * 60 * 1000;
}

async function qoderFetchJson(url: string, init?: UndiciRequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QODER_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const qoderOauthProvider: OAuthProviderDefinition = {
  metadata: {
    provider: 'qoder',
    label: 'Qoder',
    platform: 'qoder',
    enabled: true,
    loginType: 'oauth',
    requiresProjectId: false,
    supportsDirectAccountRouting: false,
    supportsCloudValidation: false,
    supportsNativeProxy: false,
    proxySupported: true,
  },
  site: {
    name: 'Qoder',
    url: 'https://api3.qoder.sh',
    platform: 'qoder',
  },
  loopback: {
    host: '127.0.0.1',
    port: 0,
    path: '/auth/callback/qoder',
    redirectUri: 'http://localhost:0/auth/callback/qoder',
  },
  discovery: {
    models: [
      'ultimate',
      'auto',
      'performance',
      'efficient',
      'qmodel_preview',
      'qmodel_latest',
      'qmodel',
      'kmodel_latest',
      'kmodel',
      'gm51model',
      'dmodel',
      'dfmodel',
      'mmodel',
    ],
    chatSuffix: '',
    proxySupported: true,
  },
  buildAuthorizationUrl: async () => {
    throw new Error('此平台使用设备码授权（device-code），请使用「新建连接」按设备码提示完成授权');
  },
  exchangeAuthorizationCode: async () => {
    throw new Error('此平台使用设备码授权（device-code），不适用授权码回调');
  },
  refreshAccessToken: async () => {
    // Qoder 的 refresh 端点对 device token 返回 403（9router 同款），重新登录即可
    throw new Error('Qoder 不提供可用 token 刷新，过期后请重新授权');
  },
  startDeviceFlow: async (): Promise<OAuthDeviceFlowStartResult> => {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    const nonce = randomUUID();
    const machineId = randomUUID();

    const params = new URLSearchParams({
      challenge,
      challenge_method: 'S256',
      machine_id: machineId,
      nonce,
    });

    return {
      deviceCode: nonce,
      userCode: nonce.slice(0, 8).toUpperCase(),
      verificationUri: `${QODER_LOGIN_URL}?${params.toString()}`,
      expiresIn: 300,
      interval: 2,
      extra: { codeVerifier: verifier, nonce, machineId },
    };
  },
  pollDeviceFlow: async ({ deviceCode, extra }): Promise<OAuthDeviceFlowPollResult> => {
    const flowExtra = extra || {};
    const nonce = deviceCode || asTrimmedString(flowExtra.nonce);
    const verifier = asTrimmedString(flowExtra.codeVerifier);
    if (!nonce || !verifier) {
      return { status: 'error', error: 'Qoder 轮询缺少 nonce/verifier' };
    }
    const url = `${QODER_DEVICE_TOKEN_URL}?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(verifier)}&challenge_method=S256`;
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await qoderFetchJson(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'Go-http-client/2.0' },
      });
    } catch (error) {
      return { status: 'pending' };
    }
    if (response.status === 202 || response.status === 404) {
      return { status: 'pending' };
    }
    const text = await response.text();
    if (!response.ok) {
      return { status: 'error', error: `Qoder 设备码轮询失败（HTTP ${response.status}）` };
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { status: 'error', error: 'Qoder 设备码轮询返回了无效 JSON' };
    }
    const accessToken = asTrimmedString(body.token);
    if (!accessToken) {
      return { status: 'error', error: 'Qoder 设备码轮询返回 200 但没有 token' };
    }

    const expireTime = parseQoderExpiry(body.expires_at, body.expires_in);
    const minSeconds = 24 * 60 * 60;
    const remainingSeconds = Math.floor((expireTime - Date.now()) / 1000);
    const expiresIn = Math.max(minSeconds, remainingSeconds);

    // 拉取用户信息（尽力而为）
    let email: string | undefined;
    try {
      const userRes = await qoderFetchJson(QODER_USERINFO_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'Go-http-client/2.0' },
      });
      if (userRes.ok) {
        const user = await userRes.json() as { email?: unknown; name?: unknown; username?: unknown };
        email = asTrimmedString(user.email);
      }
    } catch { /* non-fatal */ }

    return {
      status: 'approved',
      exchange: {
        accessToken,
        ...(asTrimmedString(body.refresh_token) ? { refreshToken: asTrimmedString(body.refresh_token) } : {}),
        ...(email ? { email } : {}),
        tokenExpiresAt: Date.now() + expiresIn * 1000,
        providerData: {
          authMethod: 'device_code',
          ...(asTrimmedString(flowExtra.machineId) ? { machineId: asTrimmedString(flowExtra.machineId) } : {}),
          ...(asTrimmedString(body.user_id) ? { qoderUserId: asTrimmedString(body.user_id) } : {}),
        },
      },
    };
  },
};
