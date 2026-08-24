import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getModelsMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts skipModelFetch behavior', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-skip-model-'));
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
    getModelsMock.mockReset();

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch { }
    }
    delete process.env.DATA_DIR;
  });

  it('skips model fetching when skipModelFetch is true under apikey credentialMode', async () => {
    getModelsMock.mockRejectedValueOnce(new Error('Should not be called'));

    const site = await db.insert(schema.sites).values({
      name: 'API Key Site',
      url: 'https://apikey.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-test-skip-fetch',
        credentialMode: 'apikey',
        skipModelFetch: true,
      },
    });

    expect(response.statusCode).toBe(200);
    // getModels should NOT be called when skipModelFetch is true
    expect(getModelsMock).toHaveBeenCalledTimes(0);

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.apiToken).toBe('sk-test-skip-fetch');
    
    // Model availability should be empty initially (background task might not have populated it yet or failed)
    const models = await db.select().from(schema.modelAvailability).all();
    expect(models).toHaveLength(0);
  });

  it('creates a keyless API connection when model fetch is skipped', async () => {
    getModelsMock.mockRejectedValueOnce(new Error('Should not be called'));

    const site = await db.insert(schema.sites).values({
      name: 'Keyless OpenCode Site',
      url: 'http://127.0.0.1:4096',
      platform: 'openai',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: '',
        credentialMode: 'apikey',
        skipModelFetch: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(getModelsMock).not.toHaveBeenCalled();

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.accessToken).toBe('');
    expect(accounts[0]?.apiToken).toBeNull();
    expect(accounts[0]?.extraConfig).toContain('"credentialMode":"apikey"');
    expect(accounts[0]?.extraConfig).toContain('"authenticationMode":"none"');
  });

  it('validates a keyless API connection by calling getModels with an empty key', async () => {
    getModelsMock.mockResolvedValueOnce(['opencode/local-model']);

    const site = await db.insert(schema.sites).values({
      name: 'Keyless OpenCode Site',
      url: 'http://127.0.0.1:4096',
      platform: 'openai',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/verify-token',
      payload: {
        siteId: site.id,
        accessToken: '',
        credentialMode: 'apikey',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      tokenType: 'apikey',
      modelCount: 1,
      models: ['opencode/local-model'],
    });
    expect(getModelsMock).toHaveBeenCalledWith(
      site.url,
      '',
      undefined,
    );
  });

  it('still calls getModels when skipModelFetch is false', async () => {
    getModelsMock.mockResolvedValue(['gpt-4']);

    const site = await db.insert(schema.sites).values({
      name: 'API Key Site',
      url: 'https://apikey.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'sk-test-normal-fetch',
        credentialMode: 'apikey',
        skipModelFetch: false,
      },
    });

    expect(response.statusCode).toBe(200);
    // getModels is called TWICE: once for block validation, once asynchronously by refreshModelsForAccount
    expect(getModelsMock).toHaveBeenCalledTimes(2);

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.apiToken).toBe('sk-test-normal-fetch');

    // Model availability should be populated since getModels was called (which refreshModels uses later or handled directly)
    // Actually our POST /api/accounts triggers rebuildTokenRoutesFromAvailability and refreshModelsForAccount asynchronously, so models might not be populated synchronously, but the mock should be called.
  });
});
