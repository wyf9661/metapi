import { fetch } from 'undici';
import { schema } from '../db/index.js';
import { withSiteRecordProxyRequestInit } from './siteProxy.js';
import { runWithSiteApiEndpointPool } from './siteApiEndpointService.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { getOAuthProviderDefinition } from './oauth/providers.js';
import { CLAUDE_DEFAULT_ANTHROPIC_VERSION } from './oauth/claudeProvider.js';
import {
  ANTIGRAVITY_DAILY_UPSTREAM_BASE_URL,
  ANTIGRAVITY_MODELS_USER_AGENT,
  ANTIGRAVITY_SANDBOX_DAILY_UPSTREAM_BASE_URL,
  ANTIGRAVITY_UPSTREAM_BASE_URL,
} from './oauth/antigravityProvider.js';
import {
  GEMINI_CLI_GOOGLE_API_CLIENT,
  GEMINI_CLI_REQUIRED_SERVICE,
  GEMINI_CLI_USER_AGENT,
} from './oauth/geminiCliProvider.js';

type PlatformDiscoverySite = typeof schema.sites.$inferSelect;
type PlatformDiscoveryAccount = typeof schema.accounts.$inferSelect;

function normalizeDiscoveredModels(models: string[]): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const rawModel of models) {
    if (typeof rawModel !== 'string') continue;
    const modelName = rawModel.trim();
    if (!modelName) continue;

    const dedupeKey = modelName.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalizedModels.push(modelName);
  }

  return normalizedModels;
}

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || '').replace(/\/+$/, '');
}

function buildCodexModelsEndpoint(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return `${normalized}/models?client_version=${encodeURIComponent('1.0.0')}`;
}

function extractCodexModelIds(payload: unknown): string[] {
  const collection = (() => {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.models)) return record.models;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.items)) return record.items;
    return [];
  })();

  return collection.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string'
      ? record.id
      : (typeof record.slug === 'string' ? record.slug : (typeof record.model === 'string' ? record.model : ''));
    return id ? [id] : [];
  });
}

function extractClaudeModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as { data?: unknown };
  if (!Array.isArray(record.data)) return [];

  return record.data.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const value = item as { id?: unknown; name?: unknown };
    const id = typeof value.id === 'string'
      ? value.id.trim()
      : (typeof value.name === 'string' ? value.name.trim() : '');
    return id ? [id] : [];
  });
}

function extractAntigravityModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as { models?: unknown };
  if (record.models && typeof record.models === 'object' && !Array.isArray(record.models)) {
    return Object.keys(record.models).map((name) => name.trim()).filter(Boolean);
  }
  if (!Array.isArray(record.models)) return [];
  return record.models.flatMap((item) => {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      return trimmed ? [trimmed] : [];
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const value = item as { id?: unknown; name?: unknown };
    const id = typeof value.id === 'string'
      ? value.id.trim()
      : (typeof value.name === 'string' ? value.name.trim() : '');
    return id ? [id] : [];
  });
}

function buildAntigravityDiscoveryBaseUrls(siteUrl: string): string[] {
  const seen = new Set<string>();
  return [
    siteUrl,
    ANTIGRAVITY_UPSTREAM_BASE_URL,
    ANTIGRAVITY_DAILY_UPSTREAM_BASE_URL,
    ANTIGRAVITY_SANDBOX_DAILY_UPSTREAM_BASE_URL,
  ].flatMap((candidate) => {
    const normalized = normalizeBaseUrl(candidate);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

export async function discoverCodexModelsFromCloud(input: {
  site: PlatformDiscoverySite;
  account: PlatformDiscoveryAccount;
}): Promise<string[]> {
  const accessToken = (input.account.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('codex oauth access token missing');
  }
  const oauth = getOauthInfoFromAccount(input.account);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    Originator: 'codex_cli_rs',
  };
  if (oauth?.accountId) {
    headers['Chatgpt-Account-Id'] = oauth.accountId;
  }

  const payload = await runWithSiteApiEndpointPool(input.site, async (target) => {
    const response = await fetch(
      buildCodexModelsEndpoint(target.baseUrl),
      withSiteRecordProxyRequestInit(input.site, { method: 'GET', headers }),
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text || 'codex model discovery failed'}`);
    }
    return response.json();
  });
  return normalizeDiscoveredModels(extractCodexModelIds(payload));
}

export async function discoverClaudeModelsFromCloud(input: {
  site: PlatformDiscoverySite;
  account: PlatformDiscoveryAccount;
}): Promise<string[]> {
  const accessToken = (input.account.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('claude oauth access token missing');
  }
  const payload = await runWithSiteApiEndpointPool(input.site, async (target) => {
    const response = await fetch(
      `${target.baseUrl.replace(/\/+$/, '')}/v1/models`,
      withSiteRecordProxyRequestInit(input.site, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'anthropic-version': CLAUDE_DEFAULT_ANTHROPIC_VERSION,
        },
      }),
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text || 'claude oauth model discovery failed'}`);
    }
    return response.json();
  });
  return normalizeDiscoveredModels(extractClaudeModelIds(payload));
}

export async function validateGeminiCliOauthConnection(input: {
  site: PlatformDiscoverySite;
  account: PlatformDiscoveryAccount;
}): Promise<void> {
  const accessToken = (input.account.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('gemini cli oauth access token missing');
  }
  const oauth = getOauthInfoFromAccount(input.account);
  const projectId = (oauth?.projectId || '').trim();
  if (!projectId) {
    throw new Error('gemini cli oauth project id missing');
  }
  const response = await fetch(
    `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(GEMINI_CLI_REQUIRED_SERVICE)}`,
    withSiteRecordProxyRequestInit(input.site, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': GEMINI_CLI_USER_AGENT,
        'X-Goog-Api-Client': GEMINI_CLI_GOOGLE_API_CLIENT,
      },
    }),
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text || 'gemini cli oauth validation failed'}`);
  }
  const payload = await response.json() as { state?: unknown };
  if (String(payload.state || '').trim().toUpperCase() !== 'ENABLED') {
    throw new Error(`Cloud AI API not enabled for project ${projectId}`);
  }
}

export async function discoverAntigravityModelsFromCloud(input: {
  site: PlatformDiscoverySite;
  account: PlatformDiscoveryAccount;
}): Promise<string[]> {
  const accessToken = (input.account.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('antigravity oauth access token missing');
  }

  const oauth = getOauthInfoFromAccount(input.account);
  const projectId = (oauth?.projectId || '').trim();
  const requestBody = projectId ? { project: projectId } : {};
  return runWithSiteApiEndpointPool(input.site, async (target) => {
    let lastError = '';
    const selectedBaseUrl = normalizeBaseUrl(target.baseUrl || ANTIGRAVITY_UPSTREAM_BASE_URL) || ANTIGRAVITY_UPSTREAM_BASE_URL;
    const discoveryBaseUrls = target.endpointId
      ? [selectedBaseUrl]
      : buildAntigravityDiscoveryBaseUrls(selectedBaseUrl);

    for (const discoveryBaseUrl of discoveryBaseUrls) {
      try {
        const response = await fetch(
          `${discoveryBaseUrl}/v1internal:fetchAvailableModels`,
          withSiteRecordProxyRequestInit(input.site, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'User-Agent': ANTIGRAVITY_MODELS_USER_AGENT,
            },
            body: JSON.stringify(requestBody),
          }),
        );
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          lastError = `HTTP ${response.status}: ${text || '未获取到可用模型'}`;
          continue;
        }

        const payload = await response.json();
        const models = normalizeDiscoveredModels(extractAntigravityModelIds(payload));
        if (models.length > 0) {
          return models;
        }
        lastError = '未获取到可用模型';
      } catch (error) {
        lastError = error instanceof Error ? `${discoveryBaseUrl}: ${error.message}` : String(error);
      }
    }

    throw new Error(lastError || '未获取到可用模型');
  });
}

/**
 * 仅导入型 OAuth 平台（9router 同款 device-flow / IDE-import）的模型发现。
 *
 * 数据源对齐 9router provider registry：
 * - discovery.modelsUrl（9router modelsFetcher.url / transport.modelsUrl）优先，
 *   GET 后解析 id/slug/model 字段（openrouter-free 目录兼容）；
 * - 失败或无 modelsUrl 时回退硬编码模型表（9router models 列表兜底）。
 */
export async function discoverImportOnlyModelsFromCloud(input: {
  site: PlatformDiscoverySite;
  account: PlatformDiscoveryAccount;
  provider: string;
}): Promise<string[]> {
  const definition = getOAuthProviderDefinition(input.provider);
  const discovery = definition?.discovery;
  if (!definition || !discovery) {
    throw new Error(`unsupported import-only oauth provider: ${input.provider}`);
  }
  const accessToken = (input.account.accessToken || '').trim();
  if (!accessToken) {
    throw new Error(`${definition.metadata.label} oauth access token missing`);
  }
  const staticModels = Array.isArray(discovery.models)
    ? discovery.models.filter((modelName) => typeof modelName === 'string' && modelName.trim())
    : [];

  if (discovery.modelsUrl) {
    try {
      const response = await fetch(
        discovery.modelsUrl,
        withSiteRecordProxyRequestInit(input.site, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        }),
      );
      if (response.ok) {
        const payload = await response.json() as unknown;
        const fetchedModels = normalizeDiscoveredModels(extractCodexModelIds(payload));
        if (fetchedModels.length > 0) {
          return fetchedModels;
        }
      }
    } catch {
      // modelsUrl 失败回退硬编码表
    }
  }

  if (staticModels.length > 0) {
    return staticModels;
  }
  throw new Error('未获取到可用模型');
}
