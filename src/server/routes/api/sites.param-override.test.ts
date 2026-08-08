import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

type DbModule = typeof import('../../db/index.js');

describe('sites param_override', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-param-override-'));
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

  async function createSite(payload: Record<string, unknown>): Promise<{
    id: number;
    paramOverride?: string | null;
  }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'override-site',
        url: 'https://override-site.example.com',
        platform: 'new-api',
        ...payload,
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { id: number; paramOverride?: string | null };
  }

  it('stores param_override when creating a site', async () => {
    const created = await createSite({
      paramOverride: '{"max_tokens": 64, "temperature": 0}',
    });
    expect(created.paramOverride).toBe('{"max_tokens": 64, "temperature": 0}');

    const row = await db.select().from(schema.sites).all();
    expect(row.length).toBe(1);
    expect(row[0].paramOverride).toBe('{"max_tokens": 64, "temperature": 0}');
  });

  it('returns param_override in the site payload', async () => {
    const created = await createSite({
      paramOverride: '{"stream": true}',
    });
    const fetched = await app.inject({ method: 'GET', url: `/api/sites/${created.id}` });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as { paramOverride?: string | null }).paramOverride).toBe('{"stream": true}');
  });

  it('updates and clears param_override', async () => {
    const created = await createSite({
      paramOverride: '{"max_tokens": 64}',
    });

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/sites/${created.id}`,
      payload: { paramOverride: '{"temperature": 1}' },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { paramOverride?: string | null }).paramOverride).toBe('{"temperature": 1}');

    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/sites/${created.id}`,
      payload: { paramOverride: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { paramOverride?: string | null }).paramOverride).toBeNull();
  });

  it('rejects invalid param_override JSON on create and update', async () => {
    const badCreate = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'bad-site',
        url: 'https://bad-site.example.com',
        platform: 'new-api',
        paramOverride: '{not json}',
      },
    });
    expect(badCreate.statusCode).toBe(400);

    const created = await createSite({});
    const badUpdate = await app.inject({
      method: 'PUT',
      url: `/api/sites/${created.id}`,
      payload: { paramOverride: '[1,2,3]' },
    });
    expect(badUpdate.statusCode).toBe(400);
  });
});
