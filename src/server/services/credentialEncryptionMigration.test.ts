import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';

type DbModule = typeof import('../db/index.js');
type CryptoModule = typeof import('../shared/credentialCrypto.js');
type MigrationModule = typeof import('./credentialEncryptionMigration.js');

describe('credential encryption migration', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let dbModule: DbModule;
  let crypto: CryptoModule;
  let migration: MigrationModule;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-migration-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    dbModule = await import('../db/index.js');
    crypto = await import('../shared/credentialCrypto.js');
    migration = await import('./credentialEncryptionMigration.js');
  });

  afterAll(async () => {
    if (dbModule) await dbModule.closeDbConnections();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  });

  it('re-seals legacy plaintext rows and is idempotent', async () => {
    const siteName = `legacy-site-${randomUUID()}`;
    const legacyKeyValue = `sk-legacy-${randomUUID()}`;
    await dbModule.db.run(sql`
      INSERT INTO sites (name, url, platform, api_key)
      VALUES (${siteName}, ${`https://legacy-${randomUUID()}.example`}, 'openai', ${legacyKeyValue})
    `);

    expect((await migration.encryptLegacyCredentials()).sealed).toBeGreaterThan(0);

    const rows = await dbModule.db.all(sql`
      SELECT api_key FROM sites WHERE name = ${siteName}
    `) as unknown[];
    const rawValue = (Array.isArray(rows[0]) ? rows[0][0] : (rows[0] as { api_key?: string }).api_key) as string;
    expect(rawValue).toBeTruthy();
    // Raw read: the column must no longer contain the plaintext.
    expect(rawValue).not.toBe(legacyKeyValue);
    expect(crypto.isEncryptedCredential(rawValue)).toBe(true);
    expect(crypto.decryptCredential(rawValue, 'site.api_key')).toBe(legacyKeyValue);

    // Second pass finds nothing left to migrate.
    expect(await migration.encryptLegacyCredentials()).toEqual({ sealed: 0, upgraded: 0, unreadable: 0 });
  });

  it('upgrades v1 envelopes to purpose-scoped v2 in place', async () => {
    const secret = (config.accountCredentialSecret || '').trim() || config.authToken || 'change-me-admin-token';
    const key = createHash('sha256').update(secret).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update('legacy-v1-value', 'utf8'), cipher.final()]);
    const envelope = [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      data.toString('base64url'),
    ].join(':');

    const v1SiteName = `v1-site-${randomUUID()}`;
    await dbModule.db.run(sql`
      INSERT INTO sites (name, url, platform, api_key)
      VALUES (${v1SiteName}, ${`https://v1-${randomUUID()}.example`}, 'openai', ${envelope})
    `);

    const summary = await migration.encryptLegacyCredentials();
    expect(summary.upgraded).toBeGreaterThan(0);

    const rows = await dbModule.db.all(sql`
      SELECT api_key FROM sites WHERE name = ${v1SiteName}
    `) as unknown[];
    const rawValue = (Array.isArray(rows[0]) ? rows[0][0] : (rows[0] as { api_key?: string }).api_key) as string;
    expect(rawValue.startsWith('v2:')).toBe(true);
    expect(crypto.decryptCredential(rawValue, 'site.api_key')).toBe('legacy-v1-value');
  });
});
