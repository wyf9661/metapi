import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  buildStoredSub2ApiSubscriptionSummary,
  mergeAccountExtraConfig,
} from '../../services/accountExtraConfig.js';

type DbModule = typeof import('../../db/index.js');

describe('sites route subscription summary aggregation', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-subscription-'));
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

  it('aggregates stored sub2api subscription summaries into /api/sites', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'sub2api-site',
      url: 'https://sub2api.example.com',
      platform: 'sub2api',
    }).returning().get();

    await db.insert(schema.accounts).values([
      {
        siteId: site.id,
        username: 'user-a',
        accessToken: 'token-a',
        balance: 10,
        status: 'active',
        extraConfig: mergeAccountExtraConfig(null, {
          sub2apiSubscription: buildStoredSub2ApiSubscriptionSummary({
            activeCount: 1,
            totalUsedUsd: 3,
            subscriptions: [
              {
                id: 11,
                groupName: 'Pro',
                expiresAt: '2026-04-10T00:00:00.000Z',
                monthlyUsedUsd: 3,
                monthlyLimitUsd: 20,
              },
            ],
          }, 1760000000000),
        }),
      },
      {
        siteId: site.id,
        username: 'user-b',
        accessToken: 'token-b',
        balance: 5,
        status: 'active',
        extraConfig: mergeAccountExtraConfig(null, {
          sub2apiSubscription: buildStoredSub2ApiSubscriptionSummary({
            activeCount: 1,
            totalUsedUsd: 2,
            subscriptions: [
              {
                id: 12,
                groupName: 'Lite',
                expiresAt: '2026-03-25T00:00:00.000Z',
                monthlyUsedUsd: 2,
                monthlyLimitUsd: 10,
              },
            ],
          }, 1760000002000),
        }),
      },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/sites',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{
      totalBalance: number;
      subscriptionSummary: {
        activeCount: number;
        totalUsedUsd: number;
        totalMonthlyLimitUsd: number | null;
        totalRemainingUsd: number | null;
        nextExpiresAt: string | null;
        planNames: string[];
        updatedAt: number | null;
      } | null;
    }>;

    expect(body).toHaveLength(1);
    expect(body[0]?.totalBalance).toBe(15);
    expect(body[0]?.subscriptionSummary).toEqual({
      activeCount: 2,
      totalUsedUsd: 5,
      totalMonthlyLimitUsd: 30,
      totalRemainingUsd: 25,
      nextExpiresAt: '2026-03-25T00:00:00.000Z',
      planNames: ['Pro', 'Lite'],
      updatedAt: 1760000002000,
    });
  });
});
