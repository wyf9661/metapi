import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');
type ConfigModule = typeof import('../../config.js');

/** Cloudflare adds cf-ray/cf-connecting-ip to every tunnelled request. */
const TUNNEL_HEADERS = { 'cf-ray': '8a1b2c3d4e5f6789-SJC' };
const LOCAL_HEADERS = { host: '127.0.0.1:4000' };

describe('tunnel access policy on admin routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-tunnel-policy-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const settingsRoutesModule = await import('./settings.js');
    const tunnelRoutesModule = await import('./tunnel.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;

    app = Fastify();
    await app.register(settingsRoutesModule.settingsRoutes);
    await app.register(tunnelRoutesModule.tunnelRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    config.tunnelDashboardAccess = false;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('blocks factory reset from the tunnel and leaves stored data untouched', async () => {
    await db.insert(schema.settings).values({ key: 'keep_me', value: 'still-here' }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/maintenance/factory-reset',
      headers: TUNNEL_HEADERS,
      payload: { confirm: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('通过公网隧道时不允许恢复出厂设置');

    const rows = await db.select().from(schema.settings).all();
    expect(rows.map((row) => row.key)).toContain('keep_me');
  });

  it('blocks database runtime switch / migration / backup import from the tunnel', async () => {
    const cases = [
      { method: 'PUT' as const, url: '/api/settings/database/runtime', payload: {} },
      { method: 'POST' as const, url: '/api/settings/database/migrate', payload: {} },
      { method: 'POST' as const, url: '/api/settings/backup/import', payload: {} },
      { method: 'POST' as const, url: '/api/settings/backup/webdav/import', payload: {} },
      { method: 'POST' as const, url: '/api/tunnel/disable', payload: {} },
      { method: 'POST' as const, url: '/api/tunnel/enable', payload: {} },
      { method: 'PUT' as const, url: '/api/tunnel/dashboard-access', payload: { dashboardAccess: false } },
    ];

    for (const item of cases) {
      const res = await app.inject({ ...item, headers: TUNNEL_HEADERS });
      expect(res.statusCode, `${item.method} ${item.url}`).toBe(403);
    }
  });

  it('keeps the same endpoints reachable from the local console', async () => {
    // Same requests arrive at the handler (400 = invalid payload) instead of 403.
    const cases = [
      { method: 'PUT' as const, url: '/api/settings/database/runtime', payload: {} },
      { method: 'POST' as const, url: '/api/settings/database/migrate', payload: {} },
      { method: 'POST' as const, url: '/api/settings/backup/import', payload: {} },
    ];

    for (const item of cases) {
      const res = await app.inject({ ...item, headers: LOCAL_HEADERS });
      expect(res.statusCode, `${item.method} ${item.url}`).toBe(400);
    }

    const factoryReset = await app.inject({
      method: 'POST',
      url: '/api/settings/maintenance/factory-reset',
      headers: LOCAL_HEADERS,
      payload: {},
    });
    expect(factoryReset.statusCode).toBe(400); // missing confirm — policy did not fire
  });

  it('blocks session/security and tunnel-policy keys from the tunnel, not other settings', async () => {
    const blocked = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      headers: TUNNEL_HEADERS,
      payload: { tunnelDashboardAccess: true },
    });
    expect(blocked.statusCode).toBe(403);

    const allowlistBlocked = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      headers: TUNNEL_HEADERS,
      payload: { adminIpAllowlist: ['10.0.0.0/8'] },
    });
    expect(allowlistBlocked.statusCode).toBe(403);

    const ordinary = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      headers: TUNNEL_HEADERS,
      payload: { sensitiveWordDetectionEnabled: false },
    });
    expect(ordinary.statusCode).toBe(200);
  });

  it('reports the authoritative tunnel flag to the console', async () => {
    const tunnelled = await app.inject({
      method: 'GET',
      url: '/api/settings/runtime',
      headers: TUNNEL_HEADERS,
    });
    expect(tunnelled.statusCode).toBe(200);
    expect(tunnelled.json().tunnelClientView).toBe(true);

    const local = await app.inject({
      method: 'GET',
      url: '/api/settings/runtime',
      headers: LOCAL_HEADERS,
    });
    expect(local.json().tunnelClientView).toBe(false);

    const status = await app.inject({
      method: 'GET',
      url: '/api/tunnel/status',
      headers: TUNNEL_HEADERS,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().tunnelClientView).toBe(true);
  });
});
