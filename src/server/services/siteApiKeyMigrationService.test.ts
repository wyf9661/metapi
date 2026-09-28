import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type MigrationModule = typeof import('./siteApiKeyMigrationService.js');

describe('siteApiKeyMigrationService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let migrateSiteApiKeysToAccounts: MigrationModule['migrateSiteApiKeysToAccounts'];
  let hasPendingLegacySiteApiKeys: MigrationModule['hasPendingLegacySiteApiKeys'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-api-key-migration-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const migrationModule = await import('./siteApiKeyMigrationService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    migrateSiteApiKeysToAccounts = migrationModule.migrateSiteApiKeysToAccounts;
    hasPendingLegacySiteApiKeys = migrationModule.hasPendingLegacySiteApiKeys;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
  });

  it('migrates site apiKey into an apikey connection, clears the site field, and removes a mirrored token row', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'legacy-site',
      url: 'https://legacy.example.com',
      platform: 'new-api',
      apiKey: 'sk-legacy-site-token',
    }).returning().get();

    const existing = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: null,
      accessToken: '',
      apiToken: 'sk-legacy-site-token',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.accountTokens).values({
      accountId: existing.id,
      name: 'default',
      token: 'sk-legacy-site-token',
      enabled: true,
      isDefault: true,
    }).run();

    const summary = await migrateSiteApiKeysToAccounts();

    expect(summary).toMatchObject({
      migrated: 0,
      deduped: 1,
      clearedSites: 1,
      removedMirrorTokens: 1,
      warned: 0,
    });

    const migratedSite = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
    expect(migratedSite?.apiKey).toBeNull();

    const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.siteId, site.id)).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.apiToken).toBe('sk-legacy-site-token');
    expect(accounts[0]?.accessToken).toBe('');
    expect(accounts[0]?.checkinEnabled).toBe(false);
    expect(JSON.parse(accounts[0]?.extraConfig || '{}')).toMatchObject({ credentialMode: 'apikey' });

    const tokens = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, existing.id)).all();
    expect(tokens).toHaveLength(0);
  });

  it('creates a new apikey connection from site apiKey when no matching connection exists', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'new-site',
      url: 'https://new-site.example.com',
      platform: 'new-api',
      apiKey: 'sk-new-site-token',
    }).returning().get();

    const summary = await migrateSiteApiKeysToAccounts();

    expect(summary).toMatchObject({
      migrated: 1,
      deduped: 0,
      clearedSites: 1,
      removedMirrorTokens: 0,
      warned: 0,
    });

    const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.siteId, site.id)).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.apiToken).toBe('sk-new-site-token');
    expect(accounts[0]?.accessToken).toBe('');
    expect(accounts[0]?.status).toBe('active');
    expect(JSON.parse(accounts[0]?.extraConfig || '{}')).toMatchObject({ credentialMode: 'apikey' });
  });

  it('warns and keeps token rows intact when an apikey connection has multiple child tokens', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const site = await db.insert(schema.sites).values({
      name: 'warn-site',
      url: 'https://warn.example.com',
      platform: 'new-api',
      apiKey: 'sk-warn-site-token',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: null,
      accessToken: '',
      apiToken: 'sk-warn-site-token',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.accountTokens).values([
      {
        accountId: account.id,
        name: 'default',
        token: 'sk-warn-site-token',
        enabled: true,
        isDefault: true,
      },
      {
        accountId: account.id,
        name: 'extra',
        token: 'sk-extra-token',
        enabled: true,
        isDefault: false,
      },
    ]).run();

    const summary = await migrateSiteApiKeysToAccounts();

    expect(summary.warned).toBe(1);
    expect(warnSpy).toHaveBeenCalled();

    const tokens = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.accountId, account.id)).all();
    expect(tokens).toHaveLength(2);
  });

  it('probes for a pending legacy site api key without loading every site and account', async () => {
    expect(await hasPendingLegacySiteApiKeys()).toBe(false);

    await db.insert(schema.sites).values({
      name: 'keyless',
      url: 'https://keyless.example.com',
      platform: 'new-api',
    }).run();
    expect(await hasPendingLegacySiteApiKeys()).toBe(false);

    await db.insert(schema.sites).values({
      name: 'blank-key',
      url: 'https://blank.example.com',
      platform: 'new-api',
      apiKey: '   ',
    }).run();
    expect(await hasPendingLegacySiteApiKeys()).toBe(false);

    await db.insert(schema.sites).values({
      name: 'legacy-key',
      url: 'https://legacy-key.example.com',
      platform: 'new-api',
      apiKey: 'sk-legacy',
    }).run();
    expect(await hasPendingLegacySiteApiKeys()).toBe(true);
  });

  it('leaves accounts untouched when no site carries a legacy api key', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'already-migrated',
      url: 'https://migrated.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: null,
      accessToken: '',
      apiToken: 'sk-account-only',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).returning().get();

    const summary = await migrateSiteApiKeysToAccounts();

    expect(summary).toEqual({
      migrated: 0,
      deduped: 0,
      clearedSites: 0,
      removedMirrorTokens: 0,
      warned: 0,
    });
    const after = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(after?.updatedAt).toBe(account.updatedAt);
  });
});
