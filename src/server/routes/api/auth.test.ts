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
});
