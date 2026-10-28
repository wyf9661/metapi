import { sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { encryptCredential, isEncryptedCredential } from '../shared/credentialCrypto.js';

/**
 * Columns that used to store credentials in plaintext. The boot migration
 * re-seals legacy values in place; reads already tolerate both shapes, so an
 * interrupted upgrade never makes a credential unreadable.
 */
const TARGETS: Array<{ table: string; column: string; purpose: import('../shared/credentialCrypto.js').CredentialPurpose }> = [
  { table: 'sites', column: 'api_key', purpose: 'site.api_key' },
  { table: 'accounts', column: 'access_token', purpose: 'account.access_token' },
  { table: 'accounts', column: 'api_token', purpose: 'account.api_token' },
  { table: 'account_tokens', column: 'token', purpose: 'account_token.token' },
  { table: 'downstream_api_keys', column: 'key', purpose: 'downstream.key' },
];

export async function encryptLegacyCredentials(): Promise<number> {
  // Raw statements below assume SQLite's `db.all` / `db.run` surface. The
  // production deployment is SQLite; other dialects keep plaintext reads and
  // are left to a dialect-specific migration.
  if (config.dbType !== 'sqlite') return 0;

  let migrated = 0;
  for (const { table, column, purpose } of TARGETS) {
    let rows: unknown[];
    try {
      rows = await db.all(sql.raw(`SELECT id, ${column} AS value FROM ${table}`)) as unknown[];
    } catch {
      // Older databases may not have the table/column yet.
      continue;
    }

    for (const raw of rows) {
      // drizzle's sqlite `all()` returns positional arrays; accept named rows
      // too so the same code survives a driver swap.
      const id = Array.isArray(raw) ? raw[0] : (raw as { id?: number }).id;
      const value = Array.isArray(raw) ? raw[1] : (raw as { value?: string | null }).value;
      if (typeof value !== 'string' || value.trim() === '' || isEncryptedCredential(value)) continue;
      if (typeof id !== 'number' && typeof id !== 'string') continue;
      const encrypted = encryptCredential(value, purpose, { deterministic: purpose === 'downstream.key' });
      const result = await db.run(sql`
        UPDATE ${sql.raw(table)}
        SET ${sql.raw(column)} = ${encrypted}
        WHERE id = ${id}
      `);
      const changes = Array.isArray(result) ? result[0] : (result as { changes?: number } | undefined)?.changes;
      migrated += Number(changes || 0);
    }
  }
  return migrated;
}
