import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('sites status cascade', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-status-cascade-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('disables and re-enables related accounts with site status', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'status-site',
      url: 'https://status-site.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'status-user',
      accessToken: 'access-token',
      status: 'active',
    }).returning().get();

    const disableResp = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}`,
      payload: { status: 'disabled' },
    });
    expect(disableResp.statusCode).toBe(200);

    const disabledAccount = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(disabledAccount?.status).toBe('disabled');

    const enableResp = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}`,
      payload: { status: 'active' },
    });
    expect(enableResp.statusCode).toBe(200);

    const enabledAccount = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(enabledAccount?.status).toBe('active');
  });

  it('does not resurrect an account the admin disabled manually', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'status-site-2',
      url: 'https://status-site-2.example.com',
      platform: 'new-api',
    }).returning().get();

    // Manual disable: the account has status disabled but NO siteCascadeDisabled marker.
    const manuallyDisabled = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'manual-disabled-user',
      accessToken: 'access-token',
      status: 'disabled',
      extraConfig: JSON.stringify({}),
    }).returning().get();

    // First disable the site (cascade marks accounts), then re-enable it.
    await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}`,
      payload: { status: 'disabled' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}`,
      payload: { status: 'active' },
    });

    const stillDisabled = await db.select().from(schema.accounts).where(eq(schema.accounts.id, manuallyDisabled.id)).get();
    expect(stillDisabled?.status).toBe('disabled');
  });

  it('resurrects cascade-disabled accounts and clears the marker', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'status-site-3',
      url: 'https://status-site-3.example.com',
      platform: 'new-api',
    }).returning().get();

    const cascadeDisabled = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cascade-disabled-user',
      accessToken: 'access-token',
      status: 'disabled',
      extraConfig: JSON.stringify({ siteCascadeDisabled: true }),
    }).returning().get();

    await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}`,
      payload: { status: 'active' },
    });

    const reEnabled = await db.select().from(schema.accounts).where(eq(schema.accounts.id, cascadeDisabled.id)).get();
    expect(reEnabled?.status).toBe('active');
    const extra = reEnabled?.extraConfig ? JSON.parse(reEnabled.extraConfig) : {};
    expect(extra.siteCascadeDisabled).toBeUndefined();
  });
});
