import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');

/**
 * The site panel's model list answers "what can this site actually be used
 * for". Availability rows only record what upstream last advertised, so a model
 * the probe disabled stayed listed right after the probe — the panel kept
 * showing the full pre-probe set.
 */
describe('GET /api/sites/:id/available-models', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let dataDir = '';
  let siteId: number;
  let accountId: number;
  let tokenId: number;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-available-models-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;

    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();

    const site = await db.insert(schema.sites).values({
      name: 'models-site',
      url: 'https://models.example.invalid',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    siteId = site.id;

    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'models-user',
      accessToken: 'token',
      status: 'active',
    }).returning().get();
    accountId = account.id;

    const token = await db.insert(schema.accountTokens).values({
      accountId,
      name: 'key',
      token: 'sk-key',
    }).returning().get();
    tokenId = token.id;

    // Upstream still advertises all three models, at both levels.
    await db.insert(schema.modelAvailability).values([
      { accountId, modelName: 'gpt-4o', available: true },
      { accountId, modelName: 'gpt-4o-mini', available: true },
      { accountId, modelName: 'claude-opus-5', available: true },
    ]).run();
    await db.insert(schema.tokenModelAvailability).values([
      { tokenId, modelName: 'gpt-4o', available: true },
      { tokenId, modelName: 'gpt-4o-mini', available: true },
      { tokenId, modelName: 'claude-opus-5', available: true },
    ]).run();
  });

  afterAll(async () => {
    await app?.close();
    await closeDbConnections?.();
    delete process.env.DATA_DIR;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function listModels(): Promise<string[]> {
    const response = await app.inject({ method: 'GET', url: `/api/sites/${siteId}/available-models` });
    expect(response.statusCode).toBe(200);
    return (response.json() as { models: string[] }).models;
  }

  it('lists every advertised model while nothing is disabled', async () => {
    expect(await listModels()).toEqual(['claude-opus-5', 'gpt-4o', 'gpt-4o-mini']);
  });

  it('drops a model disabled for this key even though upstream still advertises it', async () => {
    await db.insert(schema.siteDisabledModels).values([
      { siteId, accountId, modelName: 'gpt-4o' },
      { siteId, accountId, modelName: 'gpt-4o-mini' },
    ]).run();

    // The token-level rows still say available — exactly the state a probe
    // leaves behind, and it used to reintroduce the disabled models here.
    expect(await listModels()).toEqual(['claude-opus-5']);
  });

  it('keeps a model that another key of the same site can still use', async () => {
    const second = await db.insert(schema.accounts).values({
      siteId,
      username: 'models-user-2',
      accessToken: 'token-2',
      status: 'active',
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: second.id, modelName: 'gpt-4o', available: true,
    }).run();
    await db.insert(schema.siteDisabledModels).values({
      siteId, accountId, modelName: 'gpt-4o',
    }).run();

    expect(await listModels()).toEqual(['claude-opus-5', 'gpt-4o', 'gpt-4o-mini']);
  });
});
