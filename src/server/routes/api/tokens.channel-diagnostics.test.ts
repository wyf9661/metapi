import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

type DbModule = typeof import('../../db/index.js');

describe('GET /api/channels/:channelId/diagnostics', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-channel-diagnostics-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('returns 404 for a missing channel', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/channels/999999/diagnostics' });
    expect(response.statusCode).toBe(404);
  });

  it('aggregates channel row, override rules, and cooldown state', async () => {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'diag-model',
      enabled: true,
    }).returning().get();
    const site = await db.insert(schema.sites).values({
      name: 'diag-site',
      url: 'https://diag.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'diag-user',
      accessToken: 'access-diag',
      apiToken: 'sk-diag',
      status: 'active',
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      sourceModel: 'diag-source',
      priority: 2,
      weight: 7,
      enabled: true,
      requestOverrideRules: JSON.stringify([
        { op: 'set_if_absent', path: 'temperature', value: 0.3 },
      ]),
      cooldownLevel: 1,
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      failCount: 3,
    }).returning().get();

    const response = await app.inject({ method: 'GET', url: `/api/channels/${channel.id}/diagnostics` });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.channelId).toBe(channel.id);
    expect(body.routeId).toBe(route.id);
    expect(body.accountId).toBe(account.id);
    expect(body.sourceModel).toBe('diag-source');
    expect(body.priority).toBe(2);
    expect(body.weight).toBe(7);
    expect(body.enabled).toBe(true);
    expect(body.requestOverrideRules).toEqual([
      { op: 'set_if_absent', path: 'temperature', value: 0.3 },
    ]);
    expect(body.cooldown.level).toBe(1);
    expect(body.cooldown.failCount).toBe(3);
    expect(typeof body.cooldown.until).toBe('string');
    expect(Array.isArray(body.performance)).toBe(true);
    expect(Array.isArray(body.recentTraceIds)).toBe(true);
  });

  it('rejects an invalid channel id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/channels/abc/diagnostics' });
    expect(response.statusCode).toBe(400);
  });
});