import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./siteDisabledModels.js');

/**
 * Legacy compatibility: before v1.8 the console wrote one site-wide row
 * (account_id NULL) per disabled model, which locked the model for every key.
 * The boot migration fans those rows out to each key of the site so every key
 * keeps its own editable list.
 */
describe('fanoutSiteWideDisabledModels', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let fanout: ServiceModule['fanoutSiteWideDisabledModels'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-disabled-fanout-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const service = await import('./siteDisabledModels.js');
    db = dbModule.db;
    schema = dbModule.schema;
    fanout = service.fanoutSiteWideDisabledModels;
  });

  beforeEach(async () => {
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  const insertSite = async (name: string) => db.insert(schema.sites).values({
    name,
    url: `https://${name}.example.com`,
    platform: 'new-api',
  }).returning().get();

  const insertAccount = async (siteId: number, username: string) => db.insert(schema.accounts).values({
    siteId,
    username,
    accessToken: '',
    apiToken: '***',
    status: 'active',
  }).returning().get();

  const rowsOf = async (siteId: number) => db.select().from(schema.siteDisabledModels)
    .where(eq(schema.siteDisabledModels.siteId, siteId))
    .all();

  it('fans site-wide rows out to every key and deletes the originals', async () => {
    const site = await insertSite('codebuddy');
    const keyA = await insertAccount(site.id, 'key-a');
    const keyB = await insertAccount(site.id, 'key-b');
    await db.insert(schema.siteDisabledModels).values(
      ['glm-5.2', 'hy3', 'kimi-k2.6'].map((modelName) => ({ siteId: site.id, modelName })),
    ).run();

    await fanout();

    const rows = await rowsOf(site.id);
    expect(rows.filter((r) => r.accountId == null)).toHaveLength(0);
    expect(rows).toHaveLength(6);
    for (const key of [keyA, keyB]) {
      const models = rows.filter((r) => r.accountId === key.id).map((r) => r.modelName).sort();
      expect(models).toEqual(['glm-5.2', 'hy3', 'kimi-k2.6']);
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    const site = await insertSite('idem');
    await insertAccount(site.id, 'key-a');
    await db.insert(schema.siteDisabledModels).values({ siteId: site.id, modelName: 'gpt-5.4' }).run();

    await fanout();
    const afterFirst = await rowsOf(site.id);
    await fanout();
    const afterSecond = await rowsOf(site.id);

    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(afterSecond.filter((r) => r.accountId == null)).toHaveLength(0);
  });

  it('keeps an existing per-key row instead of duplicating it', async () => {
    const site = await insertSite('mixed');
    const keyA = await insertAccount(site.id, 'key-a');
    const keyB = await insertAccount(site.id, 'key-b');
    await db.insert(schema.siteDisabledModels).values([
      { siteId: site.id, accountId: keyA.id, modelName: 'hy3' },
      { siteId: site.id, modelName: 'hy3' },
    ]).run();

    await fanout();

    const rows = await rowsOf(site.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.accountId === keyA.id && r.modelName === 'hy3')).toHaveLength(1);
    expect(rows.filter((r) => r.accountId === keyB.id && r.modelName === 'hy3')).toHaveLength(1);
    expect(rows.filter((r) => r.accountId == null)).toHaveLength(0);
  });

  it('drops orphaned site-wide rows for sites without accounts', async () => {
    const site = await insertSite('empty');
    await db.insert(schema.siteDisabledModels).values({ siteId: site.id, modelName: 'gpt-4o' }).run();

    await fanout();

    const leftovers = await db.select().from(schema.siteDisabledModels)
      .where(and(eq(schema.siteDisabledModels.siteId, site.id), isNull(schema.siteDisabledModels.accountId)))
      .all();
    expect(leftovers).toHaveLength(0);
  });
});
