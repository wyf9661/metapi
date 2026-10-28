import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

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
    await dbModule.db.run(sql`
      INSERT INTO sites (name, url, platform, api_key)
      VALUES ('legacy-site', 'https://legacy.example', 'openai', 'sk-legacy-plain')
    `);

    expect(await migration.encryptLegacyCredentials()).toBeGreaterThan(0);

    const rows = await dbModule.db.all(sql`
      SELECT api_key FROM sites WHERE name = 'legacy-site'
    `) as unknown[];
    const rawValue = (Array.isArray(rows[0]) ? rows[0][0] : (rows[0] as { api_key?: string }).api_key) as string;
    expect(rawValue).toBeTruthy();
    // Raw read: the column must no longer contain the plaintext.
    expect(rawValue).not.toBe('sk-legacy-plain');
    expect(crypto.isEncryptedCredential(rawValue)).toBe(true);
    expect(crypto.decryptCredential(rawValue, 'site.api_key')).toBe('sk-legacy-plain');

    // Second pass finds nothing left to migrate.
    expect(await migration.encryptLegacyCredentials()).toBe(0);
  });
});
