import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');

describe('auth routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let originalDataDir: string | undefined;
  let originalAuthToken = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-auth-routes-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const configModule = await import('../../config.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./auth.js');
    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    originalAuthToken = config.authToken;

    app = Fastify();
    await app.register(routesModule.authRoutes);
  });

  beforeEach(async () => {
    config.authToken = 'secret-token';
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    config.authToken = originalAuthToken;
    await app.close();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('rejects malformed auth change payloads at the route boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/auth/change',
      payload: {
        oldToken: 'secret-token',
        newToken: 123,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid newToken. Expected string.',
    });
  });

  it('rejects new tokens shorter than 8 characters to keep startup gate satisfied', async () => {
    // Startup (assertProductionSecurity) requires AUTH_TOKEN >= 8 chars; the
    // save route must enforce the same limit so a persisted token never breaks
    // the next boot (Windows desktop users don't read server logs).
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/auth/change',
      payload: {
        oldToken: 'secret-token',
        newToken: 'short7',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: '新 Token 至少 8 个字符',
    });
  });

  it('exposes a guarded verify endpoint for the login gate', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/settings/auth/verify' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
  });

  it('keeps the verify endpoint out of the public route allowlist', async () => {
    const desktopModule = await import('../../desktop.js');

    // Guarded by the /api onRequest hook: any mismatch now fails the login.
    expect(desktopModule.isPublicApiRoute('/api/settings/auth/verify')).toBe(false);
    // The bootstrap hint endpoint must stay public for desktop first-run.
    expect(desktopModule.isPublicApiRoute('/api/settings/auth/info')).toBe(true);
  });

  it('only exposes the first-run bootstrap token to loopback clients', async () => {
    const originalDesktop = process.env.METAPI_DESKTOP;
    process.env.METAPI_DESKTOP = '1';
    try {
      config.authToken = 'bootstrap-secret-token';
      // No 'auth_token' row persisted → this is the desktop first-run case.

      const loopback = await app.inject({
        method: 'GET',
        url: '/api/settings/auth/info',
        remoteAddress: '127.0.0.1',
      });
      expect(loopback.statusCode).toBe(200);
      expect(loopback.json().bootstrapToken).toBe('bootstrap-secret-token');

      // Same request from the LAN must not publish the live admin token.
      const lan = await app.inject({
        method: 'GET',
        url: '/api/settings/auth/info',
        remoteAddress: '192.168.1.50',
      });
      expect(lan.statusCode).toBe(200);
      expect(lan.json().bootstrapToken).toBeNull();
      expect(lan.json().masked).not.toBe('bootstrap-secret-token');
    } finally {
      if (originalDesktop === undefined) delete process.env.METAPI_DESKTOP;
      else process.env.METAPI_DESKTOP = originalDesktop;
    }
  });

  it('stops exposing the bootstrap token once the token is persisted', async () => {
    const originalDesktop = process.env.METAPI_DESKTOP;
    process.env.METAPI_DESKTOP = '1';
    try {
      config.authToken = 'bootstrap-secret-token';
      await db.insert(schema.settings).values({ key: 'auth_token', value: 'user-set-token' }).run();

      const response = await app.inject({
        method: 'GET',
        url: '/api/settings/auth/info',
        remoteAddress: '127.0.0.1',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().bootstrapToken).toBeNull();
    } finally {
      if (originalDesktop === undefined) delete process.env.METAPI_DESKTOP;
      else process.env.METAPI_DESKTOP = originalDesktop;
    }
  });
});
