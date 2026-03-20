import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type StoreModule = typeof import('./proxyFileStore.js');
type RetentionModule = typeof import('./proxyFileRetentionService.js');
type ConfigModule = typeof import('../config.js');

describe('proxyFileRetentionService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;
  let retention: RetentionModule;
  let config: ConfigModule['config'];
  let dataDir = '';
  let originalRetentionDays = 0;
  let originalPruneIntervalMinutes = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-file-retention-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const storeModule = await import('./proxyFileStore.js');
    const retentionModule = await import('./proxyFileRetentionService.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    store = storeModule;
    retention = retentionModule;
    config = configModule.config;
    originalRetentionDays = config.proxyFileRetentionDays;
    originalPruneIntervalMinutes = config.proxyFileRetentionPruneIntervalMinutes;
  });

  beforeEach(async () => {
    config.proxyFileRetentionDays = originalRetentionDays;
    config.proxyFileRetentionPruneIntervalMinutes = originalPruneIntervalMinutes;
    await db.delete(schema.proxyFiles).run();
  });

  afterAll(async () => {
    config.proxyFileRetentionDays = originalRetentionDays;
    config.proxyFileRetentionPruneIntervalMinutes = originalPruneIntervalMinutes;
    const dbModule = await import('../db/index.js');
    await dbModule.closeDbConnections();
    delete process.env.DATA_DIR;
  });

  it('returns disabled when proxy file retention is turned off', async () => {
    config.proxyFileRetentionDays = 0;

    const result = await retention.cleanupExpiredProxyFiles(Date.parse('2026-03-20T00:00:00Z'));

    expect(result).toEqual({
      enabled: false,
      retentionDays: 0,
      cutoffUtc: null,
      deleted: 0,
    });
  });

  it('purges files older than the configured retention window', async () => {
    config.proxyFileRetentionDays = 7;

    await db.insert(schema.proxyFiles).values([
      {
        publicId: 'file-metapi-old',
        ownerType: 'global_proxy_token',
        ownerId: 'global',
        filename: 'old.txt',
        mimeType: 'text/plain',
        purpose: 'assistants',
        byteSize: 3,
        sha256: 'old-hash',
        contentBase64: Buffer.from('old').toString('base64'),
        createdAt: '2026-03-10 00:00:00',
        updatedAt: '2026-03-10 00:00:00',
        deletedAt: null,
      },
      {
        publicId: 'file-metapi-new',
        ownerType: 'global_proxy_token',
        ownerId: 'global',
        filename: 'new.txt',
        mimeType: 'text/plain',
        purpose: 'assistants',
        byteSize: 3,
        sha256: 'new-hash',
        contentBase64: Buffer.from('new').toString('base64'),
        createdAt: '2026-03-18 00:00:00',
        updatedAt: '2026-03-18 00:00:00',
        deletedAt: null,
      },
    ]).run();

    const result = await retention.cleanupExpiredProxyFiles(Date.parse('2026-03-20T00:00:00Z'));

    expect(result).toEqual({
      enabled: true,
      retentionDays: 7,
      cutoffUtc: '2026-03-13 00:00:00',
      deleted: 1,
    });

    const remaining = await store.listProxyFilesByOwner({ ownerType: 'global_proxy_token', ownerId: 'global' });
    expect(remaining.map((item) => item.publicId)).toEqual(['file-metapi-new']);
  });
});
