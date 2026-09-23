import { vi } from 'vitest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';

// Hoisted mock: probeRuntimeModel returns an inconclusive result (no verdict).
vi.mock('./runtimeModelProbe.js', () => ({
  probeRuntimeModel: vi.fn().mockResolvedValue({
    status: 'inconclusive',
    latencyMs: 100,
    reason: 'mock: cannot reach endpoint',
  }),
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('probeSiteModels does not disable models from an inconclusive probe', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let probeSiteModels: ModelServiceModule['probeSiteModels'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-probe-inconclusive-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    probeSiteModels = modelService.probeSiteModels;
  });

  beforeEach(async () => {
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
  });

  it('leaves the model enabled when the probe reaches no conclusion', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Inconclusive Site',
      url: 'http://127.0.0.1:1/',
      platform: 'new-api',
      status: 'active',
    }).run();
    const siteId = Number(site.lastInsertRowid);

    const account = await db.insert(schema.accounts).values({
      siteId,
      accessToken: 'tok',
      status: 'active',
    }).run();
    const accountId = Number(account.lastInsertRowid);

    const token = await db.insert(schema.accountTokens).values({
      accountId,
      name: 'test-token',
      token: 'test-token-val',
    }).run();
    const tokenId = Number(token.lastInsertRowid);

    await db.insert(schema.modelAvailability).values({
      accountId,
      modelName: 'gpt-4o',
      available: true,
    }).run();

    await db.insert(schema.tokenModelAvailability).values({
      tokenId,
      modelName: 'gpt-4o',
      available: true,
    }).run();

    const result = await probeSiteModels(siteId, { scope: 'all' });

    // The probe returned inconclusive → no models should be disabled.
    expect(result.unsupported).toBe(0);
    expect(result.inconclusive).toBeGreaterThan(0);

    // Verify the database was not touched: no site_disabled_models row
    // and model_availability still has available=true.
    const disabled = await db.select().from(schema.siteDisabledModels).all();
    expect(disabled).toHaveLength(0);

    const maRow = await db.select().from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.modelName, 'gpt-4o'),
      ))
      .get();
    expect(maRow?.available).toBe(true);
  });
});