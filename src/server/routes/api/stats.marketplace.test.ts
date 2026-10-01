import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { resetRequestRateLimitStore } from '../../middleware/requestRateLimit.js';

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
    resetRequestRateLimitStore();
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

  it('reflects availability changes after the refresh task completes (cache invalidated on task finish)', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-refresh-cache',
      url: 'https://site-refresh-cache.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'carol',
      accessToken: 'session-c',
      status: 'active',
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'refresh-cache-model',
      available: true,
      latencyMs: 42,
    }).run();

    // Warm the cache with the pre-refresh data.
    const first = await app.inject({ method: 'GET', url: '/api/models/marketplace' });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { models: Array<{ name: string; accountCount: number }> };
    expect(firstBody.models.find((m) => m.name === 'refresh-cache-model')?.accountCount).toBe(1);

    // Simulate what the background refresh does: availability data changes in the
    // DB while the task runs, and the cache is NOT explicitly cleared by callers.
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'refresh-cache-model-2',
      available: true,
      latencyMs: 43,
    }).run();

    // The endpoint cannot tell a background refresh happened; the cached payload
    // must therefore be invalidated when the refresh task finishes so the next
    // GET rebuilds from post-refresh data.
    const queued = await app.inject({
      method: 'GET',
      url: '/api/models/marketplace?refresh=1',
    });
    expect(queued.statusCode).toBe(200);
    const queuedBody = queued.json() as { meta: { refreshJobId: string | null } };
    expect(queuedBody.meta.refreshJobId).toBeTruthy();

    // Wait for the background rebuild to finish (it rewrites availability).
    const { waitForBackgroundTaskCompletion } = await import('../../services/backgroundTaskService.js');
    await waitForBackgroundTaskCompletion(queuedBody.meta.refreshJobId!);

    // Old code: the 90s pricing / 15s base cache entries still hold pre-refresh
    // data, so the new model only appears after the TTL expires or a manual
    // second refresh. Expected: visible immediately.
    const after = await app.inject({ method: 'GET', url: '/api/models/marketplace' });
    expect(after.statusCode).toBe(200);
    const afterBody = after.json() as { models: Array<{ name: string }>; meta: { cacheHit?: boolean } };
    expect(afterBody.meta.cacheHit).toBe(false);
    expect(afterBody.models.some((m) => m.name === 'refresh-cache-model-2')).toBe(true);
  });

  it('rate-limits the marketplace endpoint like the other model reads', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-ratelimit',
      url: 'https://site-ratelimit.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'dave',
      accessToken: 'session-d',
      status: 'active',
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'ratelimit-model',
      available: true,
    }).run();

    // Same budget class as /api/models/token-candidates (30/min).
    const statuses: number[] = [];
    for (let index = 0; index < 35; index += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/models/marketplace',
        remoteAddress: '10.0.0.99',
      } as any);
      statuses.push(response.statusCode);
      if (response.statusCode === 429) break;
    }
    expect(statuses[statuses.length - 1]).toBe(429);
    expect(statuses.length).toBeLessThanOrEqual(31);
  });

  it('averages latency only over accounts with a known probe (null probes are not zeros)', async () => {
    // The rate-limit test above exhausted this IP's budget for the shared
    // bucket; reset (limiter.delete is async) and let the pending deletions
    // settle before this read starts from a clean allowance.
    resetRequestRateLimitStore();
    await new Promise((resolve) => setImmediate(resolve));
    const site = await db.insert(schema.sites).values({
      name: 'site-avglatency',
      url: 'https://site-avglatency.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'probed',
      accessToken: 'session-e',
      status: 'active',
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'never-probed',
      accessToken: 'session-f',
      status: 'active',
    }).returning().get();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'avglatency-model', available: true, latencyMs: 680 },
      { accountId: accountB.id, modelName: 'avglatency-model', available: true, latencyMs: null },
    ]).run();

    const response = await app.inject({ method: 'GET', url: '/api/models/marketplace' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { models: Array<{ name: string; avgLatency: number | null }> };
    const model = body.models.find((m) => m.name === 'avglatency-model');
    expect(model).toBeDefined();
    // Old code divides by ALL accounts: 680/2 = 340. Expected: 680.
    expect(model!.avgLatency).toBe(680);
  });
});
