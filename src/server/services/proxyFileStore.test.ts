import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type StoreModule = typeof import('./proxyFileStore.js');

describe('proxyFileStore', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-files-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const storeModule = await import('./proxyFileStore.js');
    db = dbModule.db;
    schema = dbModule.schema;
    store = storeModule;
  });

  beforeEach(async () => {
    await db.delete(schema.proxyFiles).run();
  });

  afterAll(async () => {
    const dbModule = await import('../db/index.js');
    await dbModule.closeDbConnections();
    delete process.env.DATA_DIR;
  });

  it('creates, lists, and reads files within one owner namespace', async () => {
    const created = await store.saveProxyFile({
      ownerType: 'global_proxy_token',
      ownerId: 'global',
      purpose: 'assistants',
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('%PDF-1.7 test file').toString('base64'),
    });

    expect(created.publicId).toMatch(/^file[_-]metapi[_-]/);
    expect(created.byteSize).toBeGreaterThan(0);
    expect(created.mimeType).toBe('application/pdf');

    const listed = await store.listProxyFilesByOwner({ ownerType: 'global_proxy_token', ownerId: 'global' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.publicId).toBe(created.publicId);

    const loaded = await store.getProxyFileByPublicIdForOwner(created.publicId, {
      ownerType: 'global_proxy_token',
      ownerId: 'global',
    });
    expect(loaded?.filename).toBe('sample.pdf');
    expect(loaded?.contentBase64).toBe(Buffer.from('%PDF-1.7 test file').toString('base64'));
  });

  it('isolates files by owner namespace', async () => {
    const managed = await store.saveProxyFile({
      ownerType: 'managed_key',
      ownerId: '12',
      purpose: 'assistants',
      filename: 'managed.json',
      mimeType: 'application/json',
      contentBase64: Buffer.from('{"ok":true}').toString('base64'),
    });

    await store.saveProxyFile({
      ownerType: 'global_proxy_token',
      ownerId: 'global',
      purpose: 'assistants',
      filename: 'global.json',
      mimeType: 'application/json',
      contentBase64: Buffer.from('{"scope":"global"}').toString('base64'),
    });

    const managedFiles = await store.listProxyFilesByOwner({ ownerType: 'managed_key', ownerId: '12' });
    const globalFiles = await store.listProxyFilesByOwner({ ownerType: 'global_proxy_token', ownerId: 'global' });

    expect(managedFiles.map((item) => item.publicId)).toEqual([managed.publicId]);
    expect(globalFiles).toHaveLength(1);
    expect(globalFiles[0]?.publicId).not.toBe(managed.publicId);
  });

  it('soft deletes files and hides them from active lookups', async () => {
    const created = await store.saveProxyFile({
      ownerType: 'managed_key',
      ownerId: '99',
      purpose: 'assistants',
      filename: 'to-delete.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('delete me').toString('base64'),
    });

    const deleted = await store.softDeleteProxyFileByPublicIdForOwner(created.publicId, {
      ownerType: 'managed_key',
      ownerId: '99',
    });
    expect(deleted).toBe(true);

    const listed = await store.listProxyFilesByOwner({ ownerType: 'managed_key', ownerId: '99' });
    expect(listed).toEqual([]);

    const loaded = await store.getProxyFileByPublicIdForOwner(created.publicId, {
      ownerType: 'managed_key',
      ownerId: '99',
    });
    expect(loaded).toBeNull();
  });

  it('purges expired proxy files before a cutoff to control database growth', async () => {
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
        createdAt: '2026-03-01 00:00:00',
        updatedAt: '2026-03-01 00:00:00',
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
        createdAt: '2026-03-19 00:00:00',
        updatedAt: '2026-03-19 00:00:00',
        deletedAt: null,
      },
    ]).run();

    const purgeExpiredProxyFiles = (store as Record<string, any>).purgeExpiredProxyFiles;
    const deleted = await purgeExpiredProxyFiles?.('2026-03-10 00:00:00');

    expect(deleted).toBe(1);

    const remainingRows = await db.select().from(schema.proxyFiles).all();
    expect(remainingRows.map((row) => row.publicId)).toEqual(['file-metapi-new']);
  });
});
