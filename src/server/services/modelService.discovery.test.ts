import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const getApiTokenMock = vi.fn();
const getModelsMock = vi.fn();
const undiciFetchMock = vi.fn();
const proxyAgentCtorMock = vi.fn();
const refreshOauthAccessTokenSingleflightMock = vi.fn();

class MockProxyAgent {
  readonly proxyUrl: string;

  constructor(proxyUrl: string) {
    this.proxyUrl = proxyUrl;
    proxyAgentCtorMock(proxyUrl);
  }
}

class MockAgent {}

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

vi.mock('undici', () => ({
  setGlobalDispatcher: () => {},

  fetch: (...args: unknown[]) => undiciFetchMock(...args),
  ProxyAgent: MockProxyAgent,
  Agent: MockAgent,
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('refreshModelsForAccount credential discovery', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let refreshModelsForAccount: ModelServiceModule['refreshModelsForAccount'];
  let refreshModelsAndRebuildRoutes: ModelServiceModule['refreshModelsAndRebuildRoutes'];
  let rebuildTokenRoutesFromAvailability: ModelServiceModule['rebuildTokenRoutesFromAvailability'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-discovery-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    refreshModelsForAccount = modelService.refreshModelsForAccount;
    refreshModelsAndRebuildRoutes = modelService.refreshModelsAndRebuildRoutes;
    rebuildTokenRoutesFromAvailability = modelService.rebuildTokenRoutesFromAvailability;
  });

  beforeEach(async () => {
    getApiTokenMock.mockReset();
    getModelsMock.mockReset();
    undiciFetchMock.mockReset();
    proxyAgentCtorMock.mockReset();
    refreshOauthAccessTokenSingleflightMock.mockReset();

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
    const { invalidateSiteProxyCache } = await import('./siteProxy.js');
    invalidateSiteProxyCache();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('discovers models from account session credential without account_tokens', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => (
      token === 'session-token' ? ['claude-sonnet-4-5-20250929', 'claude-opus-4-6'] : []
    ));

    const site = await db.insert(schema.sites).values({
      name: 'site-a',
      url: 'https://site-a.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      errorCode: null,
      errorMessage: '',
      modelCount: 2,
      modelsPreview: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6'],
      tokenScanned: 0,
      discoveredByCredential: true,
    });

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(rows.map((row: any) => row.modelName).sort()).toEqual([
      'claude-opus-4-6',
      'claude-sonnet-4-5-20250929',
    ]);

    const tokenRows = await db.select().from(schema.tokenModelAvailability).all();
    expect(tokenRows).toHaveLength(0);
  });

  it('passes the Codex fingerprint into model discovery calls on codex-gated platforms', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => (
      token === 'session-token' ? ['gpt-6-astra', 'claude-opus-5'] : []
    ));

    const site = await db.insert(schema.sites).values({
      name: 'codex-gated',
      url: 'https://codex-gated.example.com',
      platform: 'new-api',
      status: 'active',
      protocolProfile: JSON.stringify({
        preferResponses: true,
        requireCodexClient: true,
        credentialMode: 'auto',
      }),
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'carol',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);
    expect(result).toMatchObject({ refreshed: true, status: 'success' });

    const sessionCall = getModelsMock.mock.calls.find((call) => call[1] === 'session-token');
    expect(sessionCall?.[3]).toEqual({ requireCodexClient: true });
  });

  it('does not merge session /api/user/models when ready managed tokens exist', async () => {
    // NewAPI session models are account-wide (all groups); sk /v1/models is group-bound.
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => {
      if (token === 'session-token') {
        return [
          'grok-4.5',
          'deepseek-v4-pro',
          'glm-5.2',
          'gpt-5.4',
        ];
      }
      if (token === 'sk-grok-group') {
        return ['grok-4.5'];
      }
      return [];
    });

    const site = await db.insert(schema.sites).values({
      name: 'liwan-group-bound',
      url: 'https://liwan.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'wyf9661',
      accessToken: 'session-token',
      apiToken: 'sk-grok-group',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session', platformUserId: 2209 }),
    }).returning().get();

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'key',
      token: 'sk-grok-group',
      tokenGroup: 'grok',
      source: 'sync',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).run();

    const result = await refreshModelsForAccount(account.id);
    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      modelCount: 1,
      modelsPreview: ['grok-4.5'],
      tokenScanned: 1,
      discoveredByCredential: true,
    });

    const accountRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(accountRows.map((row: any) => row.modelName)).toEqual(['grok-4.5']);

    const token = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .get();
    const tokenRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token!.id))
      .all();
    expect(tokenRows.map((row: any) => row.modelName)).toEqual(['grok-4.5']);

    // Session credential must not be queried while managed keys already yielded models.
    expect(getModelsMock.mock.calls.some((call) => call[1] === 'session-token')).toBe(false);
  });

  it('falls back to session models when managed tokens return no models', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => (
      token === 'session-token' ? ['gpt-4.1', 'claude-opus-4-6'] : []
    ));

    const site = await db.insert(schema.sites).values({
      name: 'session-fallback',
      url: 'https://session-fallback.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'fallback-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-key',
      token: 'sk-xxxx',
      source: 'sync',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).run();

    const result = await refreshModelsForAccount(account.id);
    expect(result).toMatchObject({
      refreshed: true,
      status: 'success',
      modelCount: 2,
      tokenScanned: 0,
      discoveredByCredential: true,
    });
    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(rows.map((row: any) => row.modelName).sort()).toEqual([
      'claude-opus-4-6',
      'gpt-4.1',
    ]);
    expect(getModelsMock.mock.calls.some((call) => call[1] === 'session-token')).toBe(true);
  });

  it('uses the configured ai endpoint for direct model discovery credentials', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (baseUrl: string, token: string) => (
      baseUrl === 'https://api.example.com' && token === 'session-token'
        ? ['gpt-4.1']
        : []
    ));

    const site = await db.insert(schema.sites).values({
      name: 'nihao-panel',
      url: 'https://console.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api.example.com',
      enabled: true,
      sortOrder: 0,
    }).run();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'nihao-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      modelCount: 1,
      modelsPreview: ['gpt-4.1'],
    });
    // new-api 平台 = Codex 门禁平台，发现请求自动带指纹（无站点开关）。
    expect(getModelsMock).toHaveBeenCalledWith('https://api.example.com', 'session-token', undefined, { requireCodexClient: true });
  });

  it('deduplicates discovered model names before writing availability rows', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockResolvedValue(['? ', '?', 'GPT-4.1', 'gpt-4.1']);

    const site = await db.insert(schema.sites).values({
      name: 'site-dedupe',
      url: 'https://site-dedupe.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'dedupe-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      modelCount: 2,
      modelsPreview: ['?', 'GPT-4.1'],
    });

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();

    expect(rows.map((row: any) => row.modelName).sort()).toEqual(['?', 'GPT-4.1']);
  });

  it('reuses one in-flight full refresh when concurrent callers request a rebuild', async () => {
    getApiTokenMock.mockResolvedValue(null);

    let releaseGate: (() => void) | undefined = undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = () => resolve();
    });

    getModelsMock.mockImplementation(async () => {
      await gate;
      return ['gpt-5-nano'];
    });

    const site = await db.insert(schema.sites).values({
      name: 'site-concurrent-refresh',
      url: 'https://site-concurrent-refresh.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'concurrent-refresh-user',
      accessToken: 'shared-credential',
      apiToken: 'shared-credential',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'shared-credential',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).run();

    const firstRefresh = refreshModelsAndRebuildRoutes();
    const secondRefresh = refreshModelsAndRebuildRoutes();
    await Promise.resolve();
    await Promise.resolve();
    (releaseGate as (() => void) | undefined)?.();

    const results = await Promise.allSettled([firstRefresh, secondRefresh]);
    expect(results.every((item) => item.status === 'fulfilled')).toBe(true);
    expect(getModelsMock).toHaveBeenCalledTimes(2);

    const modelRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(modelRows.map((row: any) => row.modelName)).toEqual(['gpt-5-nano']);

    const token = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .get();
    const tokenRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token!.id))
      .all();
    expect(tokenRows.map((row: any) => row.modelName)).toEqual(['gpt-5-nano']);
  });

  it('marks transient model discovery failures degraded instead of unhealthy', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error('model discovery timeout (15s)'));

    const site = await db.insert(schema.sites).values({
      name: 'site-timeout',
      url: 'https://site-timeout.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'timeout-user',
      accessToken: '',
      apiToken: 'sk-timeout',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'timeout',
    });

    const latest = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    const parsed = JSON.parse(latest!.extraConfig || '{}');
    expect(parsed.runtimeHealth?.state).toBe('degraded');
    expect(parsed.runtimeHealth?.source).toBe('model-discovery');
    expect(parsed.runtimeHealth?.reason).toBe('模型获取失败（请求超时）');
  });

  it('marks runtime health unhealthy when model discovery fails', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error('HTTP 401: invalid token'));

    const site = await db.insert(schema.sites).values({
      name: 'site-fail',
      url: 'https://site-fail.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'fail-user',
      accessToken: '',
      apiToken: 'sk-invalid',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      modelCount: 0,
      modelsPreview: [],
      tokenScanned: 0,
      status: 'failed',
      errorCode: 'unauthorized',
    });

    const latest = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    const parsed = JSON.parse(latest!.extraConfig || '{}');
    expect(parsed.runtimeHealth?.state).toBe('unhealthy');
    expect(parsed.runtimeHealth?.source).toBe('model-discovery');
    expect(parsed.runtimeHealth?.reason).toBe('模型获取失败，API Key 已无效');
    expect(parsed.runtimeHealth?.checkedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('does not scan hidden managed tokens for direct apikey connections', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => (
      token === 'sk-direct-credential' ? ['gpt-4.1'] : ['legacy-should-not-be-used']
    ));

    const site = await db.insert(schema.sites).values({
      name: 'apikey-direct-site',
      url: 'https://apikey-direct.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'apikey-direct-user',
      accessToken: '',
      apiToken: 'sk-direct-credential',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    const hiddenToken = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'legacy-hidden',
      token: 'sk-legacy-hidden',
      source: 'legacy',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
      modelCount: 1,
      modelsPreview: ['gpt-4.1'],
      tokenScanned: 0,
      discoveredByCredential: true,
    });

    const tokenRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, hiddenToken.id))
      .all();
    expect(tokenRows).toHaveLength(0);
  });

  it('returns structured result when account missing', async () => {
    const result = await refreshModelsForAccount(9999);

    expect(result).toMatchObject({
      accountId: 9999,
      refreshed: false,
      status: 'failed',
      errorCode: 'account_not_found',
      errorMessage: '账号不存在',
      modelCount: 0,
      modelsPreview: [],
      reason: 'account_not_found',
    });
  });

  it('returns structured result when site disabled', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-disabled',
      url: 'https://site-disabled.example.com',
      platform: 'new-api',
      status: 'disabled',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'disabled-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: false,
      status: 'skipped',
      errorCode: 'site_disabled',
      errorMessage: '站点已禁用',
      modelCount: 0,
      modelsPreview: [],
      reason: 'site_disabled',
    });
  });

  it('returns structured result when account inactive', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-inactive',
      url: 'https://site-inactive.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'inactive-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'disabled',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: false,
      status: 'skipped',
      errorCode: 'adapter_or_status',
      errorMessage: '平台不可用或账号未激活',
      modelCount: 0,
      modelsPreview: [],
      reason: 'adapter_or_status',
    });
  });

  it('preserves existing availability when allowInactive refresh fails', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error('upstream unavailable'));

    const site = await db.insert(schema.sites).values({
      name: 'site-rebind-refresh',
      url: 'https://site-rebind-refresh.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rebind-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'disabled',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-stored-token',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 120,
      checkedAt: '2026-03-21T11:30:00.000Z',
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 90,
      checkedAt: '2026-03-21T11:30:00.000Z',
    }).run();

    const result = await refreshModelsForAccount(account.id, { allowInactive: true });

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'failed',
      modelCount: 0,
      discoveredByCredential: false,
    });

    const modelRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(modelRows).toHaveLength(1);
    expect(modelRows[0]).toMatchObject({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
    });

    const tokenRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      tokenId: token.id,
      modelName: 'gpt-4.1',
      available: true,
    });
  });

  it('preserves existing availability when a scheduled (non-allowInactive) refresh fails', async () => {
    // Regression: a transient upstream timeout during the scheduled full pass
    // used to wipe the account's whole model set because the snapshot/restore
    // only ran for allowInactive manual refreshes (2026-09-09 CAIC).
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockRejectedValue(new Error('upstream unavailable'));

    const site = await db.insert(schema.sites).values({
      name: 'site-scheduled-fail',
      url: 'https://site-scheduled-fail.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'scheduled-fail-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-abc123',
      source: 'manual',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready' as any,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 120,
      checkedAt: '2026-03-21T11:30:00.000Z',
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-4.1',
      available: true,
      latencyMs: 90,
      checkedAt: '2026-03-21T11:30:00.000Z',
    }).run();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'failed',
      modelCount: 0,
      discoveredByCredential: false,
    });

    const modelRows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    expect(modelRows).toHaveLength(1);
    expect(modelRows[0]).toMatchObject({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
    });

    const tokenRows = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      tokenId: token.id,
      modelName: 'gpt-4.1',
      available: true,
    });
  });

  it('does not scan masked_pending placeholders as token credentials', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async (_baseUrl: string, token: string) => (
      token === 'sk-mask***tail' ? ['gpt-5.2-codex'] : []
    ));

    const site = await db.insert(schema.sites).values({
      name: 'site-placeholder',
      url: 'https://site-placeholder.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'placeholder-user',
      accessToken: '',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();

    const placeholder = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-token',
      token: 'sk-mask***tail',
      source: 'sync',
      enabled: true,
      isDefault: false,
      valueStatus: 'masked_pending' as any,
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'failed',
      tokenScanned: 0,
    });

    const placeholderModels = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, placeholder.id))
      .all();
    expect(placeholderModels).toEqual([]);
    expect(getModelsMock).not.toHaveBeenCalledWith(site.url, 'sk-mask***tail', account.username);
  });

  it('preserves manual models after successful model refresh', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockResolvedValue(['gpt-4.1', 'claude-opus-4-6']);

    const site = await db.insert(schema.sites).values({
      name: 'site-manual',
      url: 'https://site-manual.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'manual-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    // Add a manual model before refresh
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'my-custom-model',
      available: true,
      isManual: true,
    }).run();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
    });

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();

    const modelNames = rows.map((r: any) => r.modelName).sort();
    expect(modelNames).toContain('my-custom-model');
    expect(modelNames).toContain('gpt-4.1');
    expect(modelNames).toContain('claude-opus-4-6');

    const manualRow = rows.find((r: any) => r.modelName === 'my-custom-model');
    expect(manualRow?.isManual).toBe(true);
  });

  it('preserves manual models even when discovered models overlap', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockResolvedValue(['gpt-4.1', 'my-custom-model']);

    const site = await db.insert(schema.sites).values({
      name: 'site-overlap',
      url: 'https://site-overlap.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'overlap-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    // Manual model that also exists upstream
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'my-custom-model',
      available: true,
      isManual: true,
    }).run();

    const result = await refreshModelsForAccount(account.id);

    expect(result).toMatchObject({
      accountId: account.id,
      refreshed: true,
      status: 'success',
    });

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();

    // Should have gpt-4.1 (discovered) and my-custom-model (manual, kept as-is)
    const modelNames = rows.map((r: any) => r.modelName).sort();
    expect(modelNames).toEqual(['gpt-4.1', 'my-custom-model']);

    // The manual model should still have isManual=true (not overwritten by discovery)
    const manualRow = rows.find((r: any) => r.modelName === 'my-custom-model');
    expect(manualRow?.isManual).toBe(true);
  });

  it('preserves manual models when refresh fails and restores previous availability', async () => {
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockResolvedValue([]);

    const site = await db.insert(schema.sites).values({
      name: 'site-fail',
      url: 'https://site-fail.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'fail-user',
      accessToken: 'session-token',
      apiToken: null,
      status: 'active',
    }).returning().get();

    // Existing synced model
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-4.1',
      available: true,
      isManual: false,
    }).run();

    // Manual model
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'my-custom-model',
      available: true,
      isManual: true,
    }).run();

    const result = await refreshModelsForAccount(account.id, { allowInactive: true });

    expect(result).toMatchObject({
      status: 'failed',
    });

    const rows = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();

    // Both manual model and restored synced model should exist
    const modelNames = rows.map((r: any) => r.modelName).sort();
    expect(modelNames).toContain('my-custom-model');
    expect(modelNames).toContain('gpt-4.1');

    const manualRow = rows.find((r: any) => r.modelName === 'my-custom-model');
    expect(manualRow?.isManual).toBe(true);
  });

});
