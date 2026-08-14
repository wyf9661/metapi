import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  formatLocalDate,
  formatUtcSqlDateTime,
  getLocalDayRangeUtc,
  parseStoredUtcDateTime,
} from '../../services/localTimeService.js';

type DbModule = typeof import('../../db/index.js');
type RepairModule = typeof import('../../services/storedTimestampRepairService.js');

describe('stats dashboard today reward fallback', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let repairStoredCreatedAtValues: RepairModule['repairStoredCreatedAtValues'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-stats-reward-fallback-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./stats.js');
    const repairModule = await import('../../services/storedTimestampRepairService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    repairStoredCreatedAtValues = repairModule.repairStoredCreatedAtValues;

    app = Fastify();
    await app.register(routesModule.statsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('uses today income value for dashboard todayReward when reward text is empty', async () => {
    const today = formatLocalDate(new Date());
    const site = await db.insert(schema.sites).values({
      name: 'stats-site',
      url: 'https://stats-site.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'stats-user',
      accessToken: 'token',
      status: 'active',
      extraConfig: JSON.stringify({
        todayIncomeSnapshot: {
          day: today,
          baseline: 4.8,
          latest: 4.8,
          updatedAt: `${today}T10:00:00.000Z`,
        },
      }),
    }).returning().get();

    await db.insert(schema.checkinLogs).values({
      accountId: account.id,
      status: 'success',
      message: 'checked in',
      reward: '',
      createdAt: `${today} 10:01:00`,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { todayReward: number };
    expect(body.todayReward).toBe(4.8);
  });

  it('repairs ISO timestamps for dashboard today reward filtering', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'stats-iso-site',
      url: 'https://stats-iso.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'stats-iso-user',
      accessToken: 'token',
      status: 'active',
    }).returning().get();

    await db.insert(schema.checkinLogs).values({
      accountId: account.id,
      status: 'success',
      message: 'checked in',
      reward: '3.6',
      createdAt: new Date().toISOString(),
    }).run();
    await repairStoredCreatedAtValues(new Date(), { force: true });

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { todayReward: number };
    expect(body.todayReward).toBe(3.6);
  });

  it('counts dashboard today spend only inside local-day range', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'stats-spend-site',
      url: 'https://stats-spend.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'stats-spend-user',
      accessToken: 'token',
      status: 'active',
    }).returning().get();

    const { startUtc, endUtc } = getLocalDayRangeUtc();
    const startDate = parseStoredUtcDateTime(startUtc)!;
    const endDate = parseStoredUtcDateTime(endUtc)!;
    const beforeStart = formatUtcSqlDateTime(new Date(startDate.getTime() - 60_000));
    const inRange = formatUtcSqlDateTime(new Date(startDate.getTime() + 60_000));
    const afterEnd = formatUtcSqlDateTime(new Date(endDate.getTime() + 60_000));

    await db.insert(schema.proxyLogs).values([
      {
        accountId: account.id,
        status: 'success',
        estimatedCost: 1,
        createdAt: beforeStart,
      },
      {
        accountId: account.id,
        status: 'success',
        estimatedCost: 3,
        createdAt: inRange,
      },
      {
        accountId: account.id,
        status: 'success',
        estimatedCost: 5,
        createdAt: afterEnd,
      },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { todaySpend: number };
    expect(body.todaySpend).toBe(3);
  });

  it('repairs ISO timestamps for dashboard today spend filtering', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'stats-iso-spend-site',
      url: 'https://stats-iso-spend.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'stats-iso-spend-user',
      accessToken: 'token',
      status: 'active',
    }).returning().get();

    const { startUtc } = getLocalDayRangeUtc();
    const startDate = parseStoredUtcDateTime(startUtc)!;
    const inRangeIso = new Date(startDate.getTime() + 60_000).toISOString();

    await db.insert(schema.proxyLogs).values({
      accountId: account.id,
      status: 'success',
      estimatedCost: 6.4,
      createdAt: inRangeIso,
    }).run();
    await repairStoredCreatedAtValues(new Date(), { force: true });

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/dashboard',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { todaySpend: number };
    expect(body.todaySpend).toBe(6.4);
  });
});
