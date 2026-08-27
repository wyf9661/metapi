import { codexOauthProvider } from './codexProvider.js';
import { claudeOauthProvider } from './claudeProvider.js';
import { geminiCliOauthProvider } from './geminiCliProvider.js';
import { antigravityOauthProvider } from './antigravityProvider.js';
import { clineOauthProvider } from './clineProvider.js';
import { kilocodeOauthProvider } from './kilocodeProvider.js';
import {
  githubOauthProvider,
  grokCliOauthProvider,
  kimiOauthProvider,
} from './deviceCodeOauthProviders.js';
import { qoderOauthProvider } from './qoderProvider.js';
import {
  clinepassOauthProvider,
  iflowOauthProvider,
  traeOauthProvider,
  xaiOauthProvider,
} from './authCodeOauthProviders.js';
import {
  cursorOauthProvider,
  gitlabOauthProvider,
  windsurfOauthProvider,
  zedOauthProvider,
} from './importOnlyProviders.js';

// Full provider id list — browser-auth providers + import-only providers
export type OAuthProviderId =
  | 'codex' | 'claude' | 'gemini-cli' | 'antigravity'
  | 'grok' | 'github' | 'kimi' | 'qoder' | 'cursor'
  | 'gitlab' | 'kilocode' | 'cline' | 'iflow'
  | 'trae' | 'windsurf' | 'zed' | 'xai' | 'clinepass';

export type OAuthProviderMetadata = {
  provider: OAuthProviderId;
  label: string;
  platform: string;
  enabled: boolean;
  loginType: 'oauth';
  requiresProjectId: boolean;
  supportsDirectAccountRouting: boolean;
  supportsCloudValidation: boolean;
  supportsNativeProxy: boolean;
  /** 兼容性标记（不再用于拦截建连接/模型发现，保留供前端展示） */
  proxySupported?: boolean;
};

export type OAuthProviderExchangeResult = {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  email?: string;
  accountKey?: string;
  accountId?: string;
  planType?: string;
  projectId?: string;
  idToken?: string;
  providerData?: Record<string, unknown>;
};

export type OAuthProviderRefreshResult = OAuthProviderExchangeResult;

export type OAuthDeviceFlowStartResult = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  /** 平台附加数据（如 kimi 的 deviceId），随轮询回传 */
  extra?: Record<string, unknown>;
};

export type OAuthDeviceFlowPollResult = {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'error';
  exchange?: OAuthProviderExchangeResult;
  error?: string;
};

export type OAuthProviderProxyHeaderInput = {
  oauth: {
    provider: string;
    accountKey?: string;
    accountId?: string;
    projectId?: string;
    providerData?: Record<string, unknown>;
  };
  downstreamHeaders?: Record<string, unknown>;
};

export interface OAuthProviderDefinition {
  metadata: OAuthProviderMetadata;
  site: {
    name: string;
    url: string;
    platform: string;
  };
  loopback: {
    host: string;
    port: number;
    path: string;
    redirectUri: string;
  };
  /** 模型发现与传输配置（9router provider registry 对齐） */
  discovery?: {
    modelsUrl?: string;
    models?: string[];
    chatSuffix?: string;
    proxySupported?: boolean;
  };
  buildAuthorizationUrl(input: {
    state: string;
    redirectUri: string;
    codeVerifier: string;
    projectId?: string;
  }): Promise<string>;
  resolveRedirectUri?(input: {
    requestOrigin?: string;
  }): string;
  exchangeAuthorizationCode(input: {
    code: string;
    state: string;
    redirectUri: string;
    codeVerifier: string;
    projectId?: string;
    proxyUrl?: string | null;
  }): Promise<OAuthProviderExchangeResult>;
  refreshAccessToken(input: {
    refreshToken: string;
    oauth?: {
      projectId?: string;
      providerData?: Record<string, unknown>;
    };
    proxyUrl?: string | null;
  }): Promise<OAuthProviderRefreshResult>;
  buildProxyHeaders?(input: OAuthProviderProxyHeaderInput): Record<string, string>;
  /** 设备码授权（device-code flow，如 KiloCode） */
  startDeviceFlow?(input: {
    proxyUrl?: string | null;
  }): Promise<OAuthDeviceFlowStartResult>;
  pollDeviceFlow?(input: {
    deviceCode: string;
    proxyUrl?: string | null;
    extra?: Record<string, unknown>;
  }): Promise<OAuthDeviceFlowPollResult>;
}

const PROVIDERS: OAuthProviderDefinition[] = [
  codexOauthProvider,
  claudeOauthProvider,
  geminiCliOauthProvider,
  antigravityOauthProvider,
  // Device-code flow（9router 对齐）
  grokCliOauthProvider,
  githubOauthProvider,
  kimiOauthProvider,
  kilocodeOauthProvider,
  qoderOauthProvider,
  // Authorization-code flow（9router 对齐）
  clineOauthProvider,
  clinepassOauthProvider,
  xaiOauthProvider,
  iflowOauthProvider,
  traeOauthProvider,
  // 暂仅导入（协议非标准/需专用客户端头，代理不直通）
  cursorOauthProvider,
  gitlabOauthProvider,
  windsurfOauthProvider,
  zedOauthProvider,
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.metadata.provider, provider] as const));

export function listOAuthProviderDefinitions(): OAuthProviderDefinition[] {
  return PROVIDERS.slice();
}

export function getOAuthProviderDefinition(provider: string): OAuthProviderDefinition | undefined {
  return PROVIDER_BY_ID.get(provider as OAuthProviderId);
}
