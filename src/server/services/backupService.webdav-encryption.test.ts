import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

type DbModule = typeof import('../../db/index.js');
type BackupModule = typeof import('./backupService.js');
type CredentialModule = typeof import('./accountCredentialService.js');

describe('webdav config password encryption at rest', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let backup: BackupModule;
  let credentials: CredentialModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-webdav-encryption-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    backup = await import('./backupService.js');
    credentials = await import('./accountCredentialService.js');
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
  });

  beforeEach(async () => {
    await db.delete(schema.settings).where(eq(schema.settings.key, 'backup_webdav_config_v1')).run();
  });

  async function readStoredRaw(): Promise<{ password?: string } | null> {
    const row = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'backup_webdav_config_v1')).get();
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  it('stores the saved password as a v1 cipher, never plaintext', async () => {
    await backup.saveBackupWebdavConfig({
      enabled: true,
      fileUrl: 'https://dav.example.com/backups/metapi.json',
      username: 'alice',
      password: 'secret-pass',
      exportType: 'all',
    });

    const stored = await readStoredRaw();
    expect(stored?.password).toBeTruthy();
    // AES-GCM envelope shape: v1:<iv>:<tag>:<data>, no plaintext fragment.
    expect(String(stored?.password)).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(String(stored?.password)).not.toContain('secret-pass');

    // The stored value decrypts back to the original password with the app key.
    expect(credentials.decryptAccountPassword(String(stored?.password))).toBe('secret-pass');
  });

  // Data-driven migration: a config written by the OLD code (plaintext) is
  // re-encrypted on load and persisted back — no permanent marker, so restoring
  // an old backup re-runs the same migration.
  it('migrates a legacy plaintext config to ciphertext on load', async () => {
    await backup.saveBackupWebdavConfig({
      enabled: true,
      fileUrl: 'https://dav.example.com/backups/metapi.json',
      username: 'alice',
      password: 'legacy-plain',
      exportType: 'all',
    });
    // Simulate the old writer by replacing the cipher with plaintext.
    const stored = await readStoredRaw();
    await db.update(schema.settings).set({
      value: JSON.stringify({ ...stored, password: 'legacy-plain' }),
    }).where(eq(schema.settings.key, 'backup_webdav_config_v1')).run();

    const view = await backup.getBackupWebdavConfig();
    expect(view.config.hasPassword).toBe(true);

    // After the load the row is rewritten encrypted; it still works.
    const migrated = await readStoredRaw();
    expect(String(migrated?.password)).toMatch(/^v1:/);
    expect(String(migrated?.password)).not.toContain('legacy-plain');

    // Idempotent: a second load keeps a valid cipher, no double-encryption.
    await backup.getBackupWebdavConfig();
    const again = await readStoredRaw();
    expect(String(again?.password)).toMatch(/^v1:/);
    expect(credentials.decryptAccountPassword(String(again?.password))).toBe('legacy-plain');
  });

  it('keeps the password working for WebDAV auth after re-saving other fields', async () => {
    await backup.saveBackupWebdavConfig({
      enabled: true,
      fileUrl: 'https://dav.example.com/backups/metapi.json',
      username: 'alice',
      password: 'first-secret',
      exportType: 'all',
    });
    // Re-save without touching the password: the existing cipher carries over
    // as a cipher (not re-encrypting a cipher as if it were plaintext).
    await backup.saveBackupWebdavConfig({ username: 'alice-2' });

    const stored = await readStoredRaw();
    expect(credentials.decryptAccountPassword(String(stored?.password))).toBe('first-secret');

    const view = await backup.getBackupWebdavConfig();
    expect(view.config.username).toBe('alice-2');
    expect(view.config.hasPassword).toBe(true);
  });

  it('clearPassword empties the stored secret entirely', async () => {
    await backup.saveBackupWebdavConfig({
      enabled: true,
      fileUrl: 'https://dav.example.com/backups/metapi.json',
      username: 'alice',
      password: 'doomed-secret',
      exportType: 'all',
    });
    await backup.saveBackupWebdavConfig({ clearPassword: true });

    const stored = await readStoredRaw();
    expect(stored?.password).toBe('');
    const view = await backup.getBackupWebdavConfig();
    expect(view.config.hasPassword).toBe(false);
  });
});

describe('webdav config decrypt failure fail-closed', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let backup: BackupModule;
  let credentials: CredentialModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-webdav-decrypt-failclosed-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    backup = await import('./backupService.js');
    credentials = await import('./accountCredentialService.js');
  });

  afterAll(async () => {
    backup.__resetBackupWebdavSchedulerForTests();
    delete process.env.DATA_DIR;
  });

  beforeEach(async () => {
    await db.delete(schema.settings).where(eq(schema.settings.key, 'backup_webdav_config_v1')).run();
  });

  async function readStoredRaw(): Promise<{ password?: string } | null> {
    const row = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'backup_webdav_config_v1')).get();
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  async function seedCipherConfig(cipher: string, overrides: Record<string, unknown> = {}): Promise<void> {
    await db.insert(schema.settings).values({
      key: 'backup_webdav_config_v1',
      value: JSON.stringify({
        enabled: true,
        fileUrl: 'https://dav.example.com/backups/metapi.json',
        username: 'alice',
        password: cipher,
        exportType: 'all',
        autoSyncEnabled: false,
        autoSyncCron: '0 * * * *',
        ...overrides,
      }),
    }).run();
  }

  /** A well-formed v1 envelope encrypted under a DIFFERENT secret — decrypt must fail. */
  function encryptWithForeignSecret(plain: string): string {
    const key = createHash('sha256').update('other-secret').digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  /** Local fetch mock: records each outbound call's URL + Authorization header, returns 201. */
  function spyOnFetchAuth(): { calls: Array<{ url: string; auth: string | null }> } {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockImplementation(async (...callArgs: [input: RequestInfo | URL, init?: RequestInit]) => {
      const [input, init] = callArgs;
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : String((input as Request).url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers['Authorization'] ?? null });
      return new Response(null, { status: 201 });
    });
    return { calls };
  }

  /** Extract "user:pass" from a Basic Authorization header (values stay inside the test). */
  function basicAuthParts(auth: string | null): { user: string; pass: string } {
    const raw = Buffer.from(String(auth).replace(/^Basic /, ''), 'base64').toString('utf8');
    const idx = raw.indexOf(':');
    return { user: raw.slice(0, idx), pass: raw.slice(idx + 1) };
  }

  it('export with a corrupt cipher sends no outbound request (fail-closed)', async () => {
    await seedCipherConfig('v1:AAAA:BBBB:CCCC');
    const { calls } = spyOnFetchAuth();

    await expect(backup.exportBackupToWebdav()).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it('export with a cipher written under a different secret sends no outbound request (fail-closed)', async () => {
    await seedCipherConfig(encryptWithForeignSecret('stale-pass'));
    const { calls } = spyOnFetchAuth();

    await expect(backup.exportBackupToWebdav()).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it('getBackupWebdavConfig stays readable/editable on decrypt failure and leaks no cipher material', async () => {
    await seedCipherConfig('v1:AAAA:BBBB:CCCC');

    const view = await backup.getBackupWebdavConfig();
    expect(view.success).toBe(true);
    // Still usable: the user can see a password exists and re-enter one.
    expect(view.config.hasPassword).toBe(true);
    // No cipher material and no masked ciphertext in the API view.
    expect(view.config.passwordMasked).toBe('');
    expect(JSON.stringify(view)).not.toContain('v1:AAAA:BBBB:CCCC');

    // Editable: re-entering the password succeeds and restores a valid cipher.
    await backup.saveBackupWebdavConfig({ password: 're-entered-secret' });
    const stored = await readStoredRaw();
    expect(String(stored?.password)).toMatch(/^v1:/);
    expect(stored?.password).not.toBe('re-entered-secret');
    expect(credentials.decryptAccountPassword(String(stored?.password))).toBe('re-entered-secret');
  });

  it('re-entering the password restores valid auth with the new plaintext', async () => {
    await seedCipherConfig('v1:AAAA:BBBB:CCCC');
    const { calls } = spyOnFetchAuth();

    await backup.saveBackupWebdavConfig({ password: 're-entered-secret' });
    await backup.exportBackupToWebdav();

    expect(calls.length).toBe(1);
    const { user, pass } = basicAuthParts(calls[0].auth);
    expect(user).toBe('alice');
    expect(pass).toBe('re-entered-secret');
  });

  it('clearPassword removes the secret and export succeeds again', async () => {
    await seedCipherConfig('v1:AAAA:BBBB:CCCC');
    const { calls } = spyOnFetchAuth();

    await backup.saveBackupWebdavConfig({ clearPassword: true });
    const stored = await readStoredRaw();
    expect(stored?.password).toBe('');
    const view = await backup.getBackupWebdavConfig();
    expect(view.config.hasPassword).toBe(false);

    await backup.exportBackupToWebdav();
    expect(calls.length).toBe(1);
    const { pass } = basicAuthParts(calls[0].auth);
    expect(pass).toBe('');
  });

  it('a valid password still authenticates with the real plaintext', async () => {
    await backup.saveBackupWebdavConfig({
      enabled: true,
      fileUrl: 'https://dav.example.com/backups/metapi.json',
      username: 'alice',
      password: 'valid-pass',
      exportType: 'all',
    });
    const { calls } = spyOnFetchAuth();

    await backup.exportBackupToWebdav();
    expect(calls.length).toBe(1);
    const { user, pass } = basicAuthParts(calls[0].auth);
    expect(user).toBe('alice');
    expect(pass).toBe('valid-pass');
  });

  it('empty password keeps the legacy behavior: export works with no auth header', async () => {
    await seedCipherConfig('', { username: '' });
    const { calls } = spyOnFetchAuth();

    await backup.exportBackupToWebdav();
    expect(calls.length).toBe(1);
    expect(calls[0].auth).toBeNull();
  });

  it('export scope: all/preferences backups carry the webdav config row, accounts does not', async () => {
    await backup.saveBackupWebdavConfig({
      enabled: true,
      fileUrl: 'https://dav.example.com/backups/metapi.json',
      username: 'alice',
      password: 'scope-check-pass',
      exportType: 'all',
    });

    const full = await backup.exportBackup('all');
    expect(full.preferences.settings.map((row) => row.key)).toContain('backup_webdav_config_v1');

    const prefs = await backup.exportBackup('preferences');
    expect(prefs.preferences.settings.map((row) => row.key)).toContain('backup_webdav_config_v1');

    const accounts = await backup.exportBackup('accounts');
    expect(accounts).not.toHaveProperty('preferences');
  });

  it('all/preferences webdav export paths fail closed together on decrypt failure', async () => {
    await seedCipherConfig('v1:AAAA:BBBB:CCCC');
    const { calls } = spyOnFetchAuth();

    await expect(backup.exportBackupToWebdav('all')).rejects.toThrow();
    await expect(backup.exportBackupToWebdav('preferences')).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
});
