import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type MigrationModule = typeof import('./downstreamApiKeyAllowListMigration.js');

describe('downstream api key exclusion -> allow-list conversion', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let migrate: MigrationModule['migrateDownstreamKeyExclusionsToAllowLists'];
  let hasPending: MigrationModule['hasPendingDownstreamKeyExclusionMigration'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-downstream-key-migrate-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const migModule = await import('./downstreamApiKeyAllowListMigration.js');
    db = dbModule.db;
    schema = dbModule.schema;
    migrate = migModule.migrateDownstreamKeyExclusionsToAllowLists;
    hasPending = migModule.hasPendingDownstreamKeyExclusionMigration;
  });

  beforeEach(async () => {
    await db.delete(schema.downstreamApiKeys).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  async function seedSiteAndAccount(name: string): Promise<{ site: any; account: any }> {
    const site = await db.insert(schema.sites).values({
      name: `conv-${name}`,
      url: `https://${name}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${name}`,
      accessToken: `access-${name}`,
      apiToken: `sk-${name}`,
      status: 'active',
    }).returning().get();
    return { site, account };
  }

  async function insertKey(row: Record<string, unknown>): Promise<number> {
    const inserted = await db.insert(schema.downstreamApiKeys).values({
      name: String(row.name ?? `key-${Math.random()}`),
      key: String(row.key ?? `tok-${Math.random()}`),
      ...row,
    }).returning().get();
    return inserted.id;
  }

  it('hasPending is false on a clean table', async () => {
    expect(await hasPending()).toBe(false);
  });

  it('converts excluded sites to an allow-list of universe minus excluded', async () => {
    const a = await seedSiteAndAccount('a');
    const b = await seedSiteAndAccount('b');
    const c = await seedSiteAndAccount('c');

    const id = await insertKey({
      key: 'convert-sites-key',
      name: 'convert sites',
      excludedSiteIds: JSON.stringify([a.site.id]),
      excludedCredentialRefs: '[]',
    });

    expect(await hasPending()).toBe(true);
    const result = await migrate();

    expect(result.converted).toBe(1);
    expect(await hasPending()).toBe(false);

    const row = await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, id)).get();
    expect(JSON.parse(row!.allowedSiteIds!)).toEqual([b.site.id, c.site.id]);
    expect(row!.allowedCredentialRefs).toBeNull();
    expect(row!.excludedSiteIds).toBeNull();
  });

  it('converts excluded credential refs to an allow-list of universe minus excluded', async () => {
    const a = await seedSiteAndAccount('a');
    const b = await seedSiteAndAccount('b');

    const tokenB = await db.insert(schema.accountTokens).values({
      accountId: b.account.id,
      name: 'tok-b',
      token: 'sk-tok-b',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    const excludedRef = { kind: 'account_token', siteId: a.site.id, accountId: a.account.id, tokenId: 9999 };
    const id = await insertKey({
      key: 'convert-cred-key',
      name: 'convert creds',
      excludedSiteIds: '[]',
      excludedCredentialRefs: JSON.stringify([excludedRef]),
    });

    expect(await hasPending()).toBe(true);
    const result = await migrate();
    expect(result.converted).toBe(1);

    const row = await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, id)).get();
    const allowed: any[] = JSON.parse(row!.allowedCredentialRefs!);

    // excluded is dropped, both remaining credentials (a default key + b default key + b's token) survive
    expect(allowed.some((ref) => ref.kind === 'account_token' && ref.tokenId === tokenB.id)).toBe(true);
    expect(allowed.some((ref) => ref.kind === 'default_api_key' && ref.accountId === b.account.id)).toBe(true);
    expect(allowed.some((ref) => ref.kind === 'account_token' && ref.tokenId === excludedRef.tokenId)).toBe(false);
    expect(row!.excludedCredentialRefs).toBeNull();
  });

  it('skips rows that already carry an allow-list, and is idempotent', async () => {
    const a = await seedSiteAndAccount('a');
    const b = await seedSiteAndAccount('b');

    const idAlready = await insertKey({
      key: 'already-allowed',
      name: 'already allowed',
      allowedSiteIds: JSON.stringify([a.site.id]),
      allowedCredentialRefs: '[]',
      excludedSiteIds: JSON.stringify([b.site.id]), // stale legacy leftover must NOT re-trigger
    });

    const result = await migrate();
    expect(result.converted).toBe(0);
    expect(await hasPending()).toBe(false);

    const row = await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, idAlready)).get();
    expect(JSON.parse(row!.allowedSiteIds!)).toEqual([a.site.id]);

    // second run: still no-op
    expect((await migrate()).converted).toBe(0);
  });
});