import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

// Route-level regression for the site health aggregation. The old inline loop
// was first-row-wins: a disabled account sitting first masked a healthy one
// (site #283 showed 禁用 while account 292 was healthy), and healthy rows could
// never override anything. Aggregation is now order-independent over ACTIVE
// accounts with a severity order unhealthy > degraded > healthy.
describe('sites health aggregation', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-health-agg-'));
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

  async function insertSite(name: string) {
    return db.insert(schema.sites).values({
      name,
      url: `https://${name}.example.com`,
      platform: 'new-api',
    }).returning().get();
  }

  async function insertAccount(siteId: number, opts: {
    username: string;
    status: string;
    health?: { state: string; reason: string; source: string; checkedAt: string } | null;
  }) {
    return db.insert(schema.accounts).values({
      siteId,
      username: opts.username,
      accessToken: 'token',
      status: opts.status,
      extraConfig: opts.health ? JSON.stringify({ runtimeHealth: opts.health }) : null,
    }).returning().get();
  }

  async function fetchHealthState(siteId: number) {
    const response = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(response.statusCode).toBe(200);
    const list = response.json() as Array<{ id: number; healthState: { state: string } }>;
    const row = list.find((item) => item.id === siteId);
    expect(row).toBeTruthy();
    return row!.healthState.state;
  }

  it('shows healthy when a disabled account sits first and a healthy one second (#283)', async () => {
    const site = await insertSite('hybgzs');
    // 顺序与生产一致：禁用账号 id 更小（先插入），健康账号在后。
    await insertAccount(site.id, {
      username: 'disabled-key',
      status: 'disabled',
      health: { state: 'disabled', reason: '账号或站点已禁用', source: 'health-refresh', checkedAt: '2026-10-10T06:07:00.000Z' },
    });
    await insertAccount(site.id, {
      username: 'healthy-key',
      status: 'active',
      health: { state: 'healthy', reason: '余额刷新成功', source: 'balance', checkedAt: '2026-10-10T06:36:00.000Z' },
    });

    await expect(fetchHealthState(site.id)).resolves.toBe('healthy');
  });

  it('keeps degraded when one active account is degraded and another is healthy (#213)', async () => {
    const site = await insertSite('hybgzs-two-keys');
    await insertAccount(site.id, {
      username: 'healthy-key',
      status: 'active',
      health: { state: 'healthy', reason: '余额刷新成功', source: 'balance', checkedAt: '2026-10-10T06:36:00.000Z' },
    });
    await insertAccount(site.id, {
      username: 'degraded-key',
      status: 'active',
      health: { state: 'degraded', reason: '模型发现失败', source: 'model-discovery', checkedAt: '2026-10-10T06:41:00.000Z' },
    });

    await expect(fetchHealthState(site.id)).resolves.toBe('degraded');
  });

  it('is order-independent for the same account mix', async () => {
    const site = await insertSite('order-a');
    await insertAccount(site.id, {
      username: 'unhealthy-key',
      status: 'active',
      health: { state: 'unhealthy', reason: 'token 过期', source: 'balance', checkedAt: '2026-10-10T06:00:00.000Z' },
    });
    await insertAccount(site.id, {
      username: 'healthy-key',
      status: 'active',
      health: { state: 'healthy', reason: '余额刷新成功', source: 'balance', checkedAt: '2026-10-10T06:36:00.000Z' },
    });

    const siteB = await insertSite('order-b');
    await insertAccount(siteB.id, {
      username: 'healthy-key',
      status: 'active',
      health: { state: 'healthy', reason: '余额刷新成功', source: 'balance', checkedAt: '2026-10-10T06:36:00.000Z' },
    });
    await insertAccount(siteB.id, {
      username: 'unhealthy-key',
      status: 'active',
      health: { state: 'unhealthy', reason: 'token 过期', source: 'balance', checkedAt: '2026-10-10T06:00:00.000Z' },
    });

    await expect(fetchHealthState(site.id)).resolves.toBe('unhealthy');
    await expect(fetchHealthState(siteB.id)).resolves.toBe('unhealthy');
  });

  it('shows disabled only when every account is disabled', async () => {
    const site = await insertSite('all-disabled');
    await insertAccount(site.id, { username: 'k1', status: 'disabled', health: null });
    await insertAccount(site.id, {
      username: 'k2',
      status: 'disabled',
      health: { state: 'disabled', reason: '账号或站点已禁用', source: 'health-refresh', checkedAt: '2026-10-10T06:07:00.000Z' },
    });

    await expect(fetchHealthState(site.id)).resolves.toBe('disabled');
  });

  it('ignores a stale unhealthy snapshot on a disabled account', async () => {
    const site = await insertSite('stale-disabled');
    await insertAccount(site.id, {
      username: 'disabled-key',
      status: 'disabled',
      health: { state: 'unhealthy', reason: '旧快照：token 过期', source: 'balance', checkedAt: '2026-10-09T00:00:00.000Z' },
    });
    await insertAccount(site.id, {
      username: 'healthy-key',
      status: 'active',
      health: { state: 'healthy', reason: '余额刷新成功', source: 'balance', checkedAt: '2026-10-10T06:36:00.000Z' },
    });

    await expect(fetchHealthState(site.id)).resolves.toBe('healthy');
  });
});
