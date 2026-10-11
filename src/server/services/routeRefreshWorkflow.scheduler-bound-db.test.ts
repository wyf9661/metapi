import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');

// DB-backed coverage for resolveSchedulerRefreshTimeoutMs: the scheduler pass
// calls refreshModelsAndRebuildRoutesWithSchedulerBound() with no explicit
// timeout and relies on the account-count lookup; if that lookup silently
// failed it would fall back to 120 s and the dynamic fix would be a no-op.
describe('resolveSchedulerRefreshTimeoutMs (db-backed)', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let resolveSchedulerRefreshTimeoutMs: () => Promise<number>;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-route-refresh-bound-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const workflowModule = await import('./routeRefreshWorkflow.js');
    db = dbModule.db;
    schema = dbModule.schema;
    resolveSchedulerRefreshTimeoutMs = workflowModule.resolveSchedulerRefreshTimeoutMs;
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.insert(schema.sites).values({
      id: 1,
      name: 'bound-site',
      url: 'https://bound.example.com',
      platform: 'new-api',
    }).run();
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
  });

  it('returns the 120 s floor when there are no accounts', async () => {
    await expect(resolveSchedulerRefreshTimeoutMs()).resolves.toBe(120_000);
  });

  it('scales with the account count read from the database', async () => {
    for (let id = 0; id < 100; id += 1) {
      await db.insert(schema.accounts).values({
        siteId: 1,
        username: `acct-${id}`,
        accessToken: 'token',
        status: 'active',
      }).run();
    }
    // 100 账号 × 12 s = 1_200_000 ms
    await expect(resolveSchedulerRefreshTimeoutMs()).resolves.toBe(1_200_000);
  });
});