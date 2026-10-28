import { sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import {
  isEncryptedCredential,
  decryptCredential,
  encryptCredential,
  type CredentialPurpose,
} from '../shared/credentialCrypto.js';

/**
 * Columns that used to store credentials in plaintext. Sealing is *lazy*: the
 * read path already tolerates both shapes (see `readCredential`), so a boot
 * migration that half-finished — or a run against a database restored from an
 * older backup — never leaves a credential unreadable.
 */
const TARGETS: Array<{ table: string; column: string; purpose: CredentialPurpose }> = [
  { table: 'sites', column: 'api_key', purpose: 'site.api_key' },
  { table: 'accounts', column: 'access_token', purpose: 'account.access_token' },
  { table: 'accounts', column: 'api_token', purpose: 'account.api_token' },
  { table: 'account_tokens', column: 'token', purpose: 'account_token.token' },
  { table: 'downstream_api_keys', column: 'key', purpose: 'downstream.key' },
];

interface SealSummary {
  /** Rows whose plaintext was replaced with a v2 envelope. */
  sealed: number;
  /** v1 envelopes re-sealed under the purpose-scoped v2 key. */
  upgraded: number;
  /** Legacy token rows copied from `accounts.api_token` under the wrong key. */
  resealed: number;
  /** Rows that could not be read with any configured key. Left untouched. */
  unreadable: number;
}

function rowId(raw: unknown): number | string | null {
  const id = Array.isArray(raw) ? raw[0] : (raw as { id?: unknown }).id;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

function rowValue(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[1] : (raw as { value?: unknown }).value;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

async function updateValue(table: string, column: string, id: number | string, value: string): Promise<number> {
  const result = await db.run(sql`
    UPDATE ${sql.raw(table)}
    SET ${sql.raw(column)} = ${value}
    WHERE id = ${id}
  `);
  const changes = Array.isArray(result) ? result[0] : (result as { changes?: number } | undefined)?.changes;
  return Number(changes || 0);
}

async function verifyAccessTokenSeals(): Promise<number> {
  // `accounts.access_token` is nullable and may be replaced by refreshes, so it
  // is sealed on its own pass to keep the log line free of unreadable-token
  // noise from rows that were only partially configured.
  let sealed = 0;
  let rows: unknown[];
  try {
    rows = await db.all(sql.raw('SELECT id, access_token AS value FROM accounts')) as unknown[];
  } catch {
    return 0;
  }
  for (const raw of rows) {
    const id = rowId(raw);
    const value = rowValue(raw);
    if (id === null || value === null || isEncryptedCredential(value)) continue;
    const envelope = encryptCredential(value, 'account.access_token');
    sealed += await updateValue('accounts', 'access_token', id, envelope);
  }
  return sealed;
}

/**
 * Repair `account_tokens.token` rows that were copied from a *sealed*
 * `accounts.api_token` by the legacy schema bootstrap (raw SQL copies the
 * ciphertext verbatim, so the row is a valid envelope under the wrong purpose).
 * Re-seal them under the token purpose so they stay readable.
 */
async function resealMisScopedAccountTokens(summary: SealSummary): Promise<void> {
  let rows: unknown[];
  try {
    rows = await db.all(sql.raw('SELECT id, token AS value FROM account_tokens')) as unknown[];
  } catch {
    return;
  }
  for (const raw of rows) {
    const id = rowId(raw);
    const value = rowValue(raw);
    if (id === null || value === null || !isEncryptedCredential(value)) continue;
    if (decryptCredential(value, 'account_token.token') !== null) continue;
    const plain = decryptCredential(value, 'account.api_token');
    if (plain === null) continue;
    summary.resealed += await updateValue(
      'account_tokens',
      'token',
      id,
      encryptCredential(plain, 'account_token.token'),
    );
  }
}

/**
 * Seal every legacy plaintext credential still present in the database and
 * upgrade v1 envelopes to purpose-scoped v2. Returns counters for the boot log.
 */
export async function encryptLegacyCredentials(): Promise<SealSummary> {
  // The raw statements below assume SQLite's `db.all` / `db.run` surface. The
  // production deployment is SQLite; other dialects keep plaintext reads and
  // are left to a dialect-specific migration.
  if (config.dbType !== 'sqlite') return { sealed: 0, upgraded: 0, resealed: 0, unreadable: 0 };

  const summary: SealSummary = { sealed: 0, upgraded: 0, resealed: 0, unreadable: 0 };

  await resealMisScopedAccountTokens(summary);

  for (const { table, column, purpose } of TARGETS) {
    if (table === 'accounts' && column === 'access_token') continue;

    let rows: unknown[];
    try {
      rows = await db.all(sql.raw(`SELECT id, ${column} AS value FROM ${table}`)) as unknown[];
    } catch {
      // Older databases may not have the table/column yet.
      continue;
    }

    for (const raw of rows) {
      const id = rowId(raw);
      const value = rowValue(raw);
      if (id === null || value === null) continue;

      if (isEncryptedCredential(value)) {
        const plain = decryptCredential(value, purpose);
        if (plain === null) {
          summary.unreadable += 1;
          continue;
        }
        if (!value.startsWith('v2:')) {
          summary.upgraded += await updateValue(
            table,
            column,
            id,
            encryptCredential(plain, purpose, { deterministic: purpose === 'downstream.key' }),
          );
        }
        continue;
      }

      summary.sealed += await updateValue(
        table,
        column,
        id,
        encryptCredential(value, purpose, { deterministic: purpose === 'downstream.key' }),
      );
    }
  }

  summary.sealed += await verifyAccessTokenSeals();
  return summary;
}
