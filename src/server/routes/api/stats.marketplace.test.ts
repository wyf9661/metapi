import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('/api/models/marketplace', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let clearModelsMarketplaceCache: () => void;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-stats-marketplace-'));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./stats.js');
    clearModelsMarketplaceCache = routesModule.clearModelsMarketplaceCache;
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.statsRoutes);
  });

  beforeEach(async () => {
    clearModelsMarketplaceCache();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('returns account-level discovered models even when account has no managed tokens', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-no-token',
      url: 'https://site-no-token.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      accessToken: 'session-token',
      status: 'active',
      balance: 12.5,
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'claude-sonnet-4-5-20250929',
      available: true,
      latencyMs: 233,
    }).run();

    const visibleRows = await db.select().from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.modelAvailability.available, true),
          eq(schema.accounts.status, 'active'),
          eq(schema.sites.status, 'active'),
        ),
      )
      .all();
    expect(visibleRows).toHaveLength(1);

    const response = await app.inject({
      method: 'GET',
      url: '/api/models/marketplace',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      models: Array<{
        name: string;
        accountCount: number;
        tokenCount: number;
        accounts: Array<{
          id: number;
          site: string;
          username: string | null;
          tokens: Array<{ id: number; name: string; isDefault: boolean }>;
        }>;
      }>;
    };
    const model = body.models.find((item) => item.name === 'claude-sonnet-4-5-20250929');
    expect(model).toBeDefined();
    expect(model?.accountCount).toBe(1);
    expect(model?.tokenCount).toBe(0);
    expect(model?.accounts).toHaveLength(1);
    expect(model?.accounts[0]).toMatchObject({
      id: account.id,
      site: 'site-no-token',
      username: 'alice',
      tokens: [],
    });
  });

  it('canonicalizes equivalent marketplace model names and keeps original source models', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-merge',
      url: 'https://site-merge.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      accessToken: 'session-a',
      status: 'active',
      balance: 1,
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'bob',
      accessToken: 'session-b',
      status: 'active',
      balance: 2,
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'MiniMax-M2.7', available: true, latencyMs: 100 },
      { accountId: accountB.id, modelName: 'minimax/minimax-m2.7', available: true, latencyMs: 200 },
      { accountId: accountB.id, modelName: 'minimaxai/minimax-m2.7', available: true, latencyMs: 300 },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/models/marketplace',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      models: Array<{
        name: string;
        accountCount: number;
        accounts: Array<{ id: number; sourceModels?: string[] }>;
      }>;
    };

    const variants = body.models.filter((item) => /minimax.*m2\.7/i.test(item.name));
    expect(variants.map((item) => item.name)).toEqual(['minimax-m2.7']);
    const model = variants[0]!;
    expect(model.accountCount).toBe(2);
    const bob = model.accounts.find((item) => item.id === accountB.id);
    expect(bob?.sourceModels?.sort()).toEqual([
      'minimax/minimax-m2.7',
      'minimaxai/minimax-m2.7',
    ]);
    const alice = model.accounts.find((item) => item.id === accountA.id);
    expect(alice?.sourceModels).toEqual(['MiniMax-M2.7']);
  });
});
