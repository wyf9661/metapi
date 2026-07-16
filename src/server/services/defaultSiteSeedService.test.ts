import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type SeedModule = typeof import('./defaultSiteSeedService.js');

describe('defaultSiteSeedService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let ensureDefaultSitesSeeded: SeedModule['ensureDefaultSitesSeeded'];
  let DEFAULT_SITE_SEED_SETTING_KEY: SeedModule['DEFAULT_SITE_SEED_SETTING_KEY'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-default-site-seed-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const seedModule = await import('./defaultSiteSeedService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    ensureDefaultSitesSeeded = seedModule.ensureDefaultSitesSeeded;
    DEFAULT_SITE_SEED_SETTING_KEY = seedModule.DEFAULT_SITE_SEED_SETTING_KEY;
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('writes seed marker without inserting official sites on empty database', async () => {
    const summary = await ensureDefaultSitesSeeded();
    expect(summary.seeded).toBe(0);

    const sites = await db.select().from(schema.sites).all();
    expect(sites).toHaveLength(0);

    const setting = await db.select().from(schema.settings).where(eq(schema.settings.key, DEFAULT_SITE_SEED_SETTING_KEY)).get();
    expect(JSON.parse(setting?.value || 'false')).toBe(true);
  });

  it('marks first-run evaluation without changing existing sites', async () => {
    await db.insert(schema.sites).values({
      name: 'Existing Site',
      url: 'https://existing.example.com',
      platform: 'new-api',
    }).run();

    await ensureDefaultSitesSeeded();

    const sites = await db.select().from(schema.sites).all();
    expect(sites).toHaveLength(1);
    expect(sites[0]?.name).toBe('Existing Site');

    const setting = await db.select().from(schema.settings).where(eq(schema.settings.key, DEFAULT_SITE_SEED_SETTING_KEY)).get();
    expect(JSON.parse(setting?.value || 'false')).toBe(true);
  });

  it('does not seed again after the evaluation marker exists', async () => {
    await db.insert(schema.settings).values({
      key: DEFAULT_SITE_SEED_SETTING_KEY,
      value: JSON.stringify(true),
    }).run();

    await ensureDefaultSitesSeeded();

    const sites = await db.select().from(schema.sites).all();
    expect(sites).toHaveLength(0);
  });
});
