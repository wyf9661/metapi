import type { OAuthProviderDefinition, OAuthProviderId } from './providers.js';

/**
 * 仅导入型 OAuth provider 工厂。
 *
 * 9router 的部分平台（grok-cli、github、kimi、qoder、cursor 等）使用
 * device-code flow 或 IDE 本地文件导入，MetAPI 当前不实现浏览器授权流程。
 * 但这些平台的凭据可以通过「导入 JSON」直接导入——导入只需要 access_token
 * + refresh_token，不需要 buildAuthorizationUrl / exchangeAuthorizationCode。
 *
 * 登录相关方法抛出明确错误，引导用户使用导入 JSON。
 *
 * 传输与模型数据以 9router 的 provider registry
 * （/tmp/9router/open-sse/providers/registry/*.js）为基准：
 * - siteUrl = 能拼出 chat 端点的 base（9router transport.baseUrl 去端点后缀）
 * - modelsUrl = 模型发现端点（9router modelsFetcher.url / transport.modelsUrl）
 * - models = 硬编码模型表（9router models 列表，发现失败时兜底）
 * - proxySupported = false 表示协议非标准（gRPC / 自定义 SSE）或需专用头，
 *   当前代理链路无法直通，不应提供可用入口
 */
export function createImportOnlyProvider<T extends string>(input: {
  provider: T;
  label: string;
  platform: string;
  siteName: string;
  siteUrl: string;
  modelsUrl?: string;
  models: string[];
  chatSuffix?: string;
  proxySupported?: boolean;
  proxyHeaders?: Record<string, string>;
}): OAuthProviderDefinition {
  const NOT_SUPPORTED = '此平台不支持浏览器授权，请使用「导入 JSON」导入凭据';
  const proxySupported = input.proxySupported ?? true;

  return {
    metadata: {
      provider: input.provider as OAuthProviderId,
      label: input.label,
      platform: input.platform,
      enabled: true,
      loginType: 'oauth',
      requiresProjectId: false,
      supportsDirectAccountRouting: false,
      supportsCloudValidation: false,
      supportsNativeProxy: false,
      proxySupported,
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
      chatSuffix: input.chatSuffix,
      proxySupported,
    },
    buildAuthorizationUrl: async () => {
      throw new Error(NOT_SUPPORTED);
    },
    exchangeAuthorizationCode: async () => {
      throw new Error(NOT_SUPPORTED);
    },
    refreshAccessToken: async () => {
      // 导入型 provider 不支持自动刷新——用户需重新导入
      throw new Error(`此平台的 access token 已过期，请重新导入 JSON 更新凭据`);
    },
    ...(input.proxyHeaders && Object.keys(input.proxyHeaders).length > 0
      ? { buildProxyHeaders: () => ({ ...input.proxyHeaders }) }
      : {}),
  };
}

// ── 协议差异平台（可导入；授权按 9router；转发是否可用由上游协议决定）──────

export const cursorOauthProvider = createImportOnlyProvider({
  provider: 'cursor',
  label: 'Cursor',
  platform: 'cursor',
  siteName: 'Cursor',
  // 9router cursor.js: connect-grpc（StreamUnifiedChatWithTools），非 HTTP JSON
  siteUrl: 'https://api2.cursor.sh',
  models: [
    'default',
    'claude-4.5-opus-high-thinking',
    'claude-4.5-opus-high',
    'claude-4.5-sonnet-thinking',
    'claude-4.5-sonnet',
    'claude-4.5-haiku',
    'claude-4.5-opus',
    'gpt-5.2-codex',
    'claude-4.6-opus-max',
    'claude-4.6-sonnet-medium-thinking',
    'kimi-k2.5',
    'gemini-3-flash-preview',
    'gpt-5.2',
    'gpt-5.3-codex',
  ],
});

export const gitlabOauthProvider = createImportOnlyProvider({
  provider: 'gitlab',
  label: 'GitLab Duo',
  platform: 'gitlab',
  siteName: 'GitLab Duo',
  siteUrl: 'https://gitlab.com/api/v4',
  models: [
    'claude-3.7-sonnet',
    'claude-3.5-sonnet',
    'claude-haiku',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ],
});

export const windsurfOauthProvider = createImportOnlyProvider({
  provider: 'windsurf',
  label: 'Windsurf',
  platform: 'windsurf',
  siteName: 'Windsurf / Codeium',
  // 9router windsurf.js: gRPC-web protobuf（Codeium LanguageServerService）
  siteUrl: 'https://server.codeium.com',
  models: [
    'claude-sonnet-4.5',
    'claude-opus-4.5',
    'gpt-4.1',
    'gpt-4o',
    'gpt-4.5',
    'gpt-5',
    'gpt-5-codex',
    'deepseek-r1',
    'grok-code',
    'codeium-base',
  ],
});

export const zedOauthProvider = createImportOnlyProvider({
  provider: 'zed',
  label: 'Zed',
  platform: 'zed',
  siteName: 'Zed Cloud',
  // 9router zed.js: baseUrl = https://cloud.zed.dev/completions（非 /chat/completions）
  siteUrl: 'https://cloud.zed.dev',
  chatSuffix: '/completions',
  models: [
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-5.2',
    'gpt-5.2-codex',
    'claude-sonnet-4.6',
    'claude-opus-4.6',
  ],
});
