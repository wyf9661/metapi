import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const verifyTokenMock = vi.fn();
const getModelsMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts api endpoint host selection', { timeout: 15_000 }, () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-api-site-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    verifyTokenMock.mockReset();
    getModelsMock.mockReset();

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('uses the configured ai endpoint for API key verification', async () => {
    getModelsMock.mockResolvedValueOnce(['gpt-4o-mini']);

    const site = await db.insert(schema.sites).values({
      name: 'Nihao Panel',
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

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'sk-nihao',
        credentialMode: 'apikey',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      tokenType: 'apikey',
      modelCount: 1,
    });
    expect(getModelsMock).toHaveBeenCalledWith('https://api.example.com', 'sk-nihao', undefined);
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it('rotates API key verification across configured ai endpoints after a retryable failure', async () => {
    getModelsMock
      .mockRejectedValueOnce(new Error('HTTP 502: temporary upstream failure'))
      .mockResolvedValueOnce(['gpt-4o-mini']);

    const site = await db.insert(schema.sites).values({
      name: 'Nihao Pool',
      url: 'https://console.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-a.example.com',
        enabled: true,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-b.example.com',
        enabled: true,
        sortOrder: 1,
      },
    ]).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'sk-rotate',
        credentialMode: 'apikey',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      tokenType: 'apikey',
      modelCount: 1,
    });
    expect(getModelsMock).toHaveBeenNthCalledWith(1, 'https://api-a.example.com', 'sk-rotate', undefined);
    expect(getModelsMock).toHaveBeenNthCalledWith(2, 'https://api-b.example.com', 'sk-rotate', undefined);

    const endpoints = await db.select().from(schema.siteApiEndpoints).all();
    const firstEndpoint = endpoints.find((item) => item.url === 'https://api-a.example.com');
    const secondEndpoint = endpoints.find((item) => item.url === 'https://api-b.example.com');
    expect(firstEndpoint?.cooldownUntil).toBeTruthy();
    expect(firstEndpoint?.lastFailureReason).toContain('HTTP 502');
    expect(secondEndpoint?.lastSelectedAt).toBeTruthy();
  });

  it('keeps session verification on the panel host even when api endpoints exist', async () => {
    verifyTokenMock.mockResolvedValueOnce({
      tokenType: 'session',
      userInfo: { username: 'nihao-user' },
      balance: 12.5,
      apiToken: 'sk-derived',
    });

    const site = await db.insert(schema.sites).values({
      name: 'Nihao Panel',
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

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: 'session-token',
        credentialMode: 'session',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      tokenType: 'session',
      apiToken: 'sk-derived',
    });
    expect(verifyTokenMock).toHaveBeenCalledWith('https://console.example.com', 'session-token', undefined);
    expect(getModelsMock).not.toHaveBeenCalled();
  });

  it('uses the configured ai endpoint when adding an API key connection', async () => {
    getModelsMock.mockResolvedValueOnce(['gpt-4o-mini']);

    const site = await db.insert(schema.sites).values({
      name: 'Nihao Panel',
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

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-nihao-create',
        credentialMode: 'apikey',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tokenType: 'apikey',
    });
    expect(getModelsMock).toHaveBeenCalledWith('https://api.example.com', 'sk-nihao-create', undefined);
  });

  it('rotates API key account creation across configured ai endpoints after a retryable failure', async () => {
    getModelsMock
      .mockRejectedValueOnce(new Error('HTTP 502: temporary upstream failure'))
      .mockResolvedValueOnce(['gpt-4o-mini']);

    const site = await db.insert(schema.sites).values({
      name: 'Nihao Create Pool',
      url: 'https://console.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-create-a.example.com',
        enabled: true,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-create-b.example.com',
        enabled: true,
        sortOrder: 1,
      },
    ]).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-nihao-create-rotate',
        credentialMode: 'apikey',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tokenType: 'apikey',
    });
    expect(getModelsMock).toHaveBeenNthCalledWith(1, 'https://api-create-a.example.com', 'sk-nihao-create-rotate', undefined);
    expect(getModelsMock).toHaveBeenNthCalledWith(2, 'https://api-create-b.example.com', 'sk-nihao-create-rotate', undefined);
  });

  it('supports batch creating multiple API key connections for one site', async () => {
    getModelsMock
      .mockResolvedValueOnce(['gpt-4o-mini'])
      .mockResolvedValueOnce(['gpt-4.1-mini']);

    const site = await db.insert(schema.sites).values({
      name: 'Nihao Batch Pool',
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

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        username: 'batch-key',
        accessToken: 'sk-batch-a\nsk-batch-b',
        credentialMode: 'apikey',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      batch: true,
      totalCount: 2,
      createdCount: 2,
      failedCount: 0,
    });
    expect(getModelsMock).toHaveBeenNthCalledWith(1, 'https://api.example.com', 'sk-batch-a', undefined);
    expect(getModelsMock).toHaveBeenNthCalledWith(2, 'https://api.example.com', 'sk-batch-b', undefined);

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((item) => item.apiToken)).toEqual(['sk-batch-a', 'sk-batch-b']);
    expect(accounts.map((item) => item.username)).toEqual(['batch-key #1', 'batch-key #2']);
  });

  it('treats accessTokens payloads as batch API key creation even without credentialMode', async () => {
    getModelsMock
      .mockResolvedValueOnce(['gpt-4o-mini'])
      .mockResolvedValueOnce(['gpt-4.1-mini']);

    const site = await db.insert(schema.sites).values({
      name: 'Nihao Batch Array',
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

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        username: 'array-key',
        accessTokens: ['sk-array-a', 'sk-array-b'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      batch: true,
      totalCount: 2,
      createdCount: 2,
      failedCount: 0,
    });
    expect(getModelsMock).toHaveBeenNthCalledWith(1, 'https://api.example.com', 'sk-array-a', undefined);
    expect(getModelsMock).toHaveBeenNthCalledWith(2, 'https://api.example.com', 'sk-array-b', undefined);

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((item) => item.apiToken)).toEqual(['sk-array-a', 'sk-array-b']);
    expect(accounts.map((item) => item.username)).toEqual(['array-key #1', 'array-key #2']);
  });
});
