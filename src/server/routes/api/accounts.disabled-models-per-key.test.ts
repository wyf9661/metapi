import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('per-key disabled models', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-per-key-disabled-'));
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
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  async function seed() {
    const site = await db.insert(schema.sites).values({
      name: 'Codebuddy', url: 'https://codebuddy.example.com', platform: 'new-api',
    }).returning().get();
    const keyA = await db.insert(schema.accounts).values({
      siteId: site.id, name: 'key-a', accessToken: 'sk-a',
    }).returning().get();
    const keyB = await db.insert(schema.accounts).values({
      siteId: site.id, name: 'key-b', accessToken: 'sk-b',
    }).returning().get();
    await db.insert(schema.modelAvailability).values([
      { accountId: keyA.id, modelName: 'shared-model', available: true },
      { accountId: keyA.id, modelName: 'only-a', available: true },
      { accountId: keyB.id, modelName: 'shared-model', available: true },
      { accountId: keyB.id, modelName: 'only-b', available: true },
    ]).run();
    return { site, keyA, keyB };
  }

  async function disabledRowsFor(siteId: number) {
    const rows = await db.select().from(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, siteId)).all();
    return rows
      .map((r: any) => ({ accountId: r.accountId ?? null, modelName: r.modelName }))
      .sort((a: any, b: any) => {
        const left = a.accountId ?? -1;
        const right = b.accountId ?? -1;
        return left === right ? a.modelName.localeCompare(b.modelName) : left - right;
      });
  }

  it("keeps each key's disabled models independent", async () => {
    const { site, keyA, keyB } = await seed();

    const resA = await app.inject({
      method: 'PUT', url: `/api/accounts/${keyA.id}/models/disabled`,
      payload: { models: ['only-a'] },
    });
    expect(resA.statusCode).toBe(200);

    const resB = await app.inject({
      method: 'PUT', url: `/api/accounts/${keyB.id}/models/disabled`,
      payload: { models: ['shared-model'] },
    });
    expect(resB.statusCode).toBe(200);

    // Saving key B must not have wiped key A's set.
    expect(await disabledRowsFor(site.id)).toEqual([
      { accountId: keyA.id, modelName: 'only-a' },
      { accountId: keyB.id, modelName: 'shared-model' },
    ]);

    const listA = (await app.inject({ method: 'GET', url: `/api/accounts/${keyA.id}/models` })).json();
    const listB = (await app.inject({ method: 'GET', url: `/api/accounts/${keyB.id}/models` })).json();
    const flagged = (list: any) => list.models.filter((m: any) => m.disabled).map((m: any) => m.name);
    expect(flagged(listA)).toEqual(['only-a']);
    expect(flagged(listB)).toEqual(['shared-model']);
  });

  it('keeps a disabled model listed even when availability no longer reports it (so it can be re-enabled)', async () => {
    const { site, keyA } = await seed();
    await db.insert(schema.siteDisabledModels).values({
      siteId: site.id, accountId: keyA.id, modelName: 'shared-model',
    }).run();
    // The probe marked the model unavailable for this key afterwards.
    await db.update(schema.modelAvailability)
      .set({ available: false })
      .where(eq(schema.modelAvailability.accountId, keyA.id))
      .run();

    const listA = (await app.inject({ method: 'GET', url: `/api/accounts/${keyA.id}/models` })).json();
    const entry = listA.models.find((m: any) => m.name === 'shared-model');
    expect(entry).toMatchObject({ disabled: true });
    // The model is still there: the key can re-enable it instead of being stuck.
    expect(listA.models.some((m: any) => m.name === 'shared-model')).toBe(true);
  });

  it('saving one key leaves site-wide rows and other keys untouched', async () => {
    const { site, keyA, keyB } = await seed();
    await db.insert(schema.siteDisabledModels).values([
      { siteId: site.id, accountId: null, modelName: 'shared-model' },
      { siteId: site.id, accountId: keyB.id, modelName: 'only-b' },
    ]).run();

    const res = await app.inject({
      method: 'PUT', url: `/api/accounts/${keyA.id}/models/disabled`,
      payload: { models: ['only-a'] },
    });
    expect(res.statusCode).toBe(200);

    expect(await disabledRowsFor(site.id)).toEqual([
      { accountId: null, modelName: 'shared-model' },
      { accountId: keyA.id, modelName: 'only-a' },
      { accountId: keyB.id, modelName: 'only-b' },
    ]);
  });

  it('rejects an unknown account and an invalid payload', async () => {
    const { keyA } = await seed();
    const missing = await app.inject({
      method: 'PUT', url: '/api/accounts/999999/models/disabled',
      payload: { models: [] },
    });
    expect(missing.statusCode).toBe(404);

    const invalid = await app.inject({
      method: 'PUT', url: `/api/accounts/${keyA.id}/models/disabled`,
      payload: { models: 'not-an-array' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
