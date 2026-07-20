import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

import type * as DbModuleType from '../../db/index.js';

describe('site deletion connection cascade', () => {
  let app: FastifyInstance;
  let db: typeof DbModuleType.db;
  let schema: typeof DbModuleType.schema;
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-delete-cascade-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const sitesModule = await import('./sites.js');
    const accountsModule = await import('./accounts.js');
    const snapshotModule = await import('../../services/snapshotCacheService.js');
    db = dbModule.db;
    schema = dbModule.schema;

    snapshotModule.clearSnapshotCache();
    app = Fastify();
    await app.register(sitesModule.sitesRoutes);
    await app.register(accountsModule.accountsRoutes);
  });

  beforeEach(async () => {
    const snapshotModule = await import('../../services/snapshotCacheService.js');
    snapshotModule.clearSnapshotCache();
    await db.delete(schema.adminSnapshots).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteAnnouncements).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('removes account/token/availability/channel rows and invalidates cached connections immediately', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'delete-cascade-site',
      url: 'https://delete-cascade.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'delete-cascade-account',
      accessToken: '',
      apiToken: 'sk-delete-cascade',
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-delete-cascade',
      status: 'active',
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5',
      available: true,
    }).run();
    await db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'gpt-5',
      available: true,
    }).run();

    // Warm connection-management cache before deletion.
    const warm = await app.inject({ method: 'GET', url: '/api/accounts?limit=100' });
    expect(warm.statusCode).toBe(200);
    expect(JSON.stringify(warm.json())).toContain('delete-cascade-account');

    const deleted = await app.inject({ method: 'DELETE', url: `/api/sites/${site.id}` });
    expect(deleted.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/accounts?limit=100' });
    expect(after.statusCode).toBe(200);
    expect(JSON.stringify(after.json())).not.toContain('delete-cascade-account');

    expect(await db.select().from(schema.accounts).all()).toHaveLength(0);
    expect(await db.select().from(schema.accountTokens).all()).toHaveLength(0);
    expect(await db.select().from(schema.modelAvailability).all()).toHaveLength(0);
    expect(await db.select().from(schema.tokenModelAvailability).all()).toHaveLength(0);
  });

  it('removes pure API Key connections that only store accounts.api_token', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'apikey-only-site',
      url: 'https://apikey-only.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: null,
      accessToken: '',
      apiToken: 'sk-live-apikey-only-delete-me',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.4',
      available: true,
      connectivity: true,
    }).run();
    // Intentionally no account_tokens row — matches pure API Key create path.

    const warm = await app.inject({ method: 'GET', url: '/api/accounts?limit=100' });
    expect(warm.statusCode).toBe(200);
    // Snapshot may not echo raw apiToken; assert by site/account presence.
    expect(JSON.stringify(warm.json())).toContain('apikey-only-site');

    const deleted = await app.inject({ method: 'DELETE', url: `/api/sites/${site.id}` });
    expect(deleted.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/accounts?limit=100' });
    expect(after.statusCode).toBe(200);
    expect(JSON.stringify(after.json())).not.toContain('apikey-only-site');
    expect(JSON.stringify(after.json())).not.toContain('sk-live-apikey-only-delete-me');

    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).all()).toHaveLength(0);
    expect(await db.select().from(schema.modelAvailability).where(eq(schema.modelAvailability.accountId, account.id)).all()).toHaveLength(0);
    expect(await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).all()).toHaveLength(0);
  });
});
