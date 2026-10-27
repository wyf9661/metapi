import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type CacheModule = typeof import('./snapshotCacheService.js');
type HealthModule = typeof import('./accountHealthService.js');

describe('setAccountRuntimeHealth drops the cached accounts snapshot', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let setAccountRuntimeHealth: HealthModule['setAccountRuntimeHealth'];
  let readSnapshotCache: CacheModule['readSnapshotCache'];
  let clearSnapshotCache: CacheModule['clearSnapshotCache'];
  let dataDir = '';
  let previousDataDir: string | undefined;
  let previousVitestEnv: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    previousVitestEnv = process.env.VITEST;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-health-snapshot-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const cacheModule = await import('./snapshotCacheService.js');
    const healthModule = await import('./accountHealthService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    readSnapshotCache = cacheModule.readSnapshotCache;
    clearSnapshotCache = cacheModule.clearSnapshotCache;
    setAccountRuntimeHealth = healthModule.setAccountRuntimeHealth;
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousVitestEnv === undefined) delete process.env.VITEST;
    else process.env.VITEST = previousVitestEnv;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('clears the accounts snapshot so the next poll rebuilds from the database', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'health-site',
      url: 'https://health-site.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'health-user',
      accessToken: 'access-token',
      status: 'active',
    }).returning().get();

    // snapshotCacheService bypasses itself under VITEST; lift that so the
    // read-through path under test behaves like production.
    delete process.env.VITEST;
    try {
      clearSnapshotCache();
      let loads = 0;
      const options = {
        namespace: 'accounts-snapshot',
        key: 'all',
        ttlMs: 60_000,
        loader: async () => {
          loads += 1;
          return { loads };
        },
      };

      const primed = await readSnapshotCache(options);
      expect(primed.cacheStatus).toBe('miss');
      const cached = await readSnapshotCache(options);
      expect(cached.cacheStatus).toBe('hit');
      expect(loads).toBe(1);

      await setAccountRuntimeHealth(account.id, {
        state: 'healthy',
        reason: '模型探测成功',
        source: 'model-discovery',
      });

      const afterRecovery = await readSnapshotCache(options);
      expect(afterRecovery.cacheStatus).toBe('miss');
      expect(loads).toBe(2);
    } finally {
      if (previousVitestEnv === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitestEnv;
    }

    const stored = await db.select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    const parsed = JSON.parse(stored?.extraConfig || '{}');
    expect(parsed.runtimeHealth).toMatchObject({
      state: 'healthy',
      source: 'model-discovery',
    });
  });
});