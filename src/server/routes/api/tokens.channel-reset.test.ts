import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('POST /api/channels/:channelId/reset', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let seedId = 0;

  const nextId = () => {
    seedId += 1;
    return seedId;
  };

  const seedAccountWithToken = async (modelName?: string) => {
    const id = nextId();
    const site = await db.insert(schema.sites).values({
      name: `reset-site-${id}`,
      url: `https://reset-site-${id}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `reset-user-${id}`,
      accessToken: `reset-access-token-${id}`,
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `reset-token-${id}`,
      token: `reset-token-value-${id}`,
      enabled: true,
      isDefault: true,
    }).returning().get();

    if (modelName) {
      await db.insert(schema.tokenModelAvailability).values({
        tokenId: token.id,
        modelName,
        available: true,
      }).run();
    }

    return { site, account, token };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-channel-reset-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');

    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    seedId = 0;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('rejects a malformed channel id', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/channels/not-a-number/reset' });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for a channel that does not exist', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/channels/987654/reset' });
    expect(response.statusCode).toBe(404);
  });

  it('restores the derived state in place and keeps the accumulated stats', async () => {
    const seeded = await seedAccountWithToken('gpt-4o');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^gpt-4o.*$',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: seeded.account.id,
      tokenId: seeded.token.id,
      sourceModel: 'gpt-4o-hand-picked',
      priority: 9,
      weight: 44,
      enabled: false,
      manualOverride: true,
      requestOverrideRules: JSON.stringify([{ op: 'set', path: '/temperature', value: 0.1 }]),
      successCount: 31,
      failCount: 2,
      totalCost: 0.75,
      totalLatencyMs: 4_200,
      lastUsedAt: '2026-09-26T09:00:00.000Z',
    }).returning().get();

    const response = await app.inject({ method: 'POST', url: `/api/channels/${channel.id}/reset` });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.success).toBe(true);
    expect(payload.derived).toBe(true);
    expect(payload.channel).toMatchObject({
      id: channel.id,
      sourceModel: 'gpt-4o',
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
      requestOverrideRules: null,
      successCount: 31,
      failCount: 2,
      totalCost: 0.75,
      totalLatencyMs: 4_200,
    });

    const persisted = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(persisted).toMatchObject({
      id: channel.id,
      manualOverride: false,
      sourceModel: 'gpt-4o',
      successCount: 31,
    });
  });

  it('keeps the row untouched with 409 when the channel has no derivable default', async () => {
    const seeded = await seedAccountWithToken();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^nowhere-model.*$',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: seeded.account.id,
      tokenId: seeded.token.id,
      sourceModel: 'nowhere-model-hand-added',
      priority: 5,
      weight: 20,
      enabled: true,
      manualOverride: true,
      successCount: 7,
    }).returning().get();

    const response = await app.inject({ method: 'POST', url: `/api/channels/${channel.id}/reset` });

    expect(response.statusCode).toBe(409);
    expect(response.json().success).toBe(false);

    const persisted = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(persisted).toMatchObject({
      id: channel.id,
      sourceModel: 'nowhere-model-hand-added',
      priority: 5,
      weight: 20,
      manualOverride: true,
      successCount: 7,
    });
  });
});
