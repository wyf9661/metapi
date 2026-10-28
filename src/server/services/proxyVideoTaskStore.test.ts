import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type StoreModule = typeof import('./proxyVideoTaskStore.js');

describe('proxyVideoTaskStore', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let dbModule: DbModule;
  let store: StoreModule;
  let config: typeof import('../config.js')['config'];
  let originalCredentialSecret: string;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-video-task-token-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    dbModule = await import('../db/index.js');
    store = await import('./proxyVideoTaskStore.js');
    ({ config } = await import('../config.js'));
    originalCredentialSecret = config.accountCredentialSecret;
  });

  beforeEach(async () => {
    config.accountCredentialSecret = 'video-task-test-encryption-secret';
    await dbModule.db.delete(dbModule.schema.proxyVideoTasks).run();
  });

  afterAll(async () => {
    if (config) config.accountCredentialSecret = originalCredentialSecret;
    if (dbModule) await dbModule.closeDbConnections();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  });

  it('accepts parsed object input for JSON column helpers', () => {
    expect(store.__proxyVideoTaskStoreTestUtils.parseJsonColumn({
      status: 'done',
      id: 'video-1',
    })).toEqual({
      status: 'done',
      id: 'video-1',
    });
  });

  it('encrypts new upstream tokens at rest and returns their plaintext to the mapped task reader', async () => {
    const token = 'sk-video-task-fixture-123';
    const saved = await store.saveProxyVideoTask({
      publicId: 'vid_encrypted',
      upstreamVideoId: 'upstream-123',
      siteUrl: 'https://upstream.example.com',
      tokenValue: token,
      requestedModel: 'sora-2',
      actualModel: 'sora-2-upstream',
      channelId: 12,
      accountId: null,
      statusSnapshot: { status: 'queued' },
    });

    const raw = await dbModule.db.select().from(dbModule.schema.proxyVideoTasks)
      .where(eq(dbModule.schema.proxyVideoTasks.publicId, saved.publicId)).get();
    expect(raw?.tokenValue).toMatch(/^v\d+:/);
    expect(raw?.tokenValue).not.toContain(token);
    expect(raw?.tokenValue).not.toBe(token);

    const mapping = await store.getProxyVideoTaskByPublicId(saved.publicId);
    expect(mapping).toMatchObject({
      publicId: saved.publicId,
      upstreamVideoId: 'upstream-123',
      siteUrl: 'https://upstream.example.com',
      tokenValue: token,
      requestedModel: 'sora-2',
      actualModel: 'sora-2-upstream',
      channelId: 12,
      statusSnapshot: { status: 'queued' },
    });

    await store.refreshProxyVideoTaskSnapshot(saved.publicId, { statusSnapshot: { status: 'running' } });
    const refreshed = await store.getProxyVideoTaskByPublicId(saved.publicId);
    expect(refreshed).toMatchObject({
      upstreamVideoId: 'upstream-123',
      tokenValue: token,
      statusSnapshot: { status: 'running' },
    });
    const storedAfterRefresh = await dbModule.db.select().from(dbModule.schema.proxyVideoTasks)
      .where(eq(dbModule.schema.proxyVideoTasks.publicId, saved.publicId)).get();
    expect(storedAfterRefresh?.tokenValue).toBe(raw?.tokenValue);
  });

  it('encrypts legacy plaintext tokens on startup without changing task IDs or timestamps', async () => {
    const createdAt = '2026-04-01 00:00:00';
    await dbModule.db.insert(dbModule.schema.proxyVideoTasks).values({
      publicId: 'vid_startup_legacy',
      upstreamVideoId: 'upstream-startup',
      siteUrl: 'https://upstream.example.com',
      tokenValue: 'legacy-task-token',
      createdAt,
      updatedAt: createdAt,
    }).run();

    await expect(store.encryptLegacyProxyVideoTaskTokens()).resolves.toBe(1);
    const raw = await dbModule.db.select().from(dbModule.schema.proxyVideoTasks)
      .where(eq(dbModule.schema.proxyVideoTasks.publicId, 'vid_startup_legacy')).get();
    expect(raw?.tokenValue).toMatch(/^v\d+:/);
    expect(raw?.tokenValue).not.toContain('legacy-task-token');
    expect(raw?.createdAt).toBe(createdAt);
    expect(raw?.updatedAt).toBe(createdAt);
    expect((await store.getProxyVideoTaskByPublicId('vid_startup_legacy'))?.tokenValue).toBe('legacy-task-token');
    await expect(store.encryptLegacyProxyVideoTaskTokens()).resolves.toBe(0);
  });

  it('reads a historical plaintext token and retains the existing mapped task fields', async () => {
    const token = 'legacy-video-token';
    await dbModule.db.insert(dbModule.schema.proxyVideoTasks).values({
      publicId: 'vid_legacy',
      upstreamVideoId: 'upstream-legacy',
      siteUrl: 'https://legacy.example.com',
      tokenValue: token,
      requestedModel: 'sora-2',
      actualModel: 'sora-2',
      channelId: null,
      accountId: null,
      statusSnapshot: JSON.stringify({ status: 'running' }),
      upstreamResponseMeta: JSON.stringify({ contentType: 'application/json' }),
      lastUpstreamStatus: 200,
      lastPolledAt: '2026-04-01 00:00:00',
    }).run();

    expect(await store.getProxyVideoTaskByPublicId('vid_legacy')).toMatchObject({
      publicId: 'vid_legacy',
      upstreamVideoId: 'upstream-legacy',
      siteUrl: 'https://legacy.example.com',
      tokenValue: token,
      statusSnapshot: { status: 'running' },
      upstreamResponseMeta: { contentType: 'application/json' },
      lastUpstreamStatus: 200,
      lastPolledAt: '2026-04-01 00:00:00',
    });
    const raw = await dbModule.db.select().from(dbModule.schema.proxyVideoTasks)
      .where(eq(dbModule.schema.proxyVideoTasks.publicId, 'vid_legacy')).get();
    expect(raw?.tokenValue).toBe(token);
  });

  it('rejects a mapped task with the wrong encryption key without exposing its ciphertext', async () => {
    await store.saveProxyVideoTask({
      publicId: 'vid_wrong_key',
      upstreamVideoId: 'upstream-wrong-key',
      siteUrl: 'https://upstream.example.com',
      tokenValue: 'sk-wrong-key-fixture',
      requestedModel: 'sora-2',
      actualModel: 'sora-2',
      channelId: null,
      accountId: null,
    });
    const raw = await dbModule.db.select().from(dbModule.schema.proxyVideoTasks)
      .where(eq(dbModule.schema.proxyVideoTasks.publicId, 'vid_wrong_key')).get();
    config.accountCredentialSecret = 'different-key-for-test';

    await expect(store.getProxyVideoTaskByPublicId('vid_wrong_key'))
      .rejects.toThrow('Proxy video task token decryption failed');
    const unchanged = await dbModule.db.select().from(dbModule.schema.proxyVideoTasks)
      .where(eq(dbModule.schema.proxyVideoTasks.publicId, 'vid_wrong_key')).get();
    expect(unchanged?.tokenValue).toBe(raw?.tokenValue);
  });

  it('fails closed for a malformed encrypted envelope rather than returning a Bearer token', async () => {
    await dbModule.db.insert(dbModule.schema.proxyVideoTasks).values({
      publicId: 'vid_bad_envelope',
      upstreamVideoId: 'upstream-bad-envelope',
      siteUrl: 'https://upstream.example.com',
      tokenValue: 'v1:malformed',
    }).run();

    await expect(store.getProxyVideoTaskByPublicId('vid_bad_envelope'))
      .rejects.toThrow('Proxy video task token decryption failed');
  });

  it('does not forward an unrecognized encrypted envelope version as a plaintext Bearer token', async () => {
    await dbModule.db.insert(dbModule.schema.proxyVideoTasks).values({
      publicId: 'vid_future_envelope',
      upstreamVideoId: 'upstream-future-envelope',
      siteUrl: 'https://upstream.example.com',
      tokenValue: 'v2:opaque-envelope-data',
    }).run();

    await expect(store.getProxyVideoTaskByPublicId('vid_future_envelope'))
      .rejects.toThrow('Proxy video task token decryption failed');
  });
});
