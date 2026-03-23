import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

type DbModule = typeof import('../../db/index.js');

describe('sites proxy settings', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-proxy-url-'));
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

  it('stores proxy settings, external checkin url, and custom headers when creating a site', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'proxy-site',
        url: 'https://proxy-site.example.com',
        platform: 'new-api',
        proxyUrl: 'socks5://127.0.0.1:1080',
        useSystemProxy: true,
        customHeaders: JSON.stringify({
          'cf-access-client-id': 'site-client-id',
          'x-site-scope': 'internal',
        }),
        externalCheckinUrl: 'https://checkin.example.com/welfare',
        globalWeight: 1.5,
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      proxyUrl?: string | null;
      useSystemProxy?: boolean;
      customHeaders?: string | null;
      externalCheckinUrl?: string | null;
      globalWeight?: number;
    };
    expect(payload.proxyUrl).toBe('socks5://127.0.0.1:1080');
    expect(payload.useSystemProxy).toBe(true);
    expect(payload.customHeaders).toBe('{"cf-access-client-id":"site-client-id","x-site-scope":"internal"}');
    expect(payload.externalCheckinUrl).toBe('https://checkin.example.com/welfare');
    expect(payload.globalWeight).toBe(1.5);
  });

  it('returns a conflict response when the same platform and url already exist', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'existing-site',
        url: 'https://duplicate-site.example.com/',
        platform: 'new-api',
      },
    });
    expect(first.statusCode).toBe(200);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'duplicate-site',
        url: 'https://duplicate-site.example.com',
        platform: 'new-api',
      },
    });

    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as { error?: string }).error).toContain('already exists');
  });

  it('rejects invalid useSystemProxy flag', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'proxy-site',
        url: 'https://proxy-site.example.com',
        platform: 'new-api',
        useSystemProxy: 'not-a-boolean',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error?: string }).error).toContain('Invalid useSystemProxy');
  });

  it('rejects invalid proxy url', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'proxy-site',
        url: 'https://proxy-site.example.com',
        platform: 'new-api',
        proxyUrl: 'not-a-proxy',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error?: string }).error).toContain('Invalid proxyUrl');
  });

  it('rejects invalid site global weight', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'weight-site',
        url: 'https://weight-site.example.com',
        platform: 'new-api',
        globalWeight: 0,
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error?: string }).error).toContain('Invalid globalWeight');
  });

  it('rejects invalid external checkin url', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'welfare-site',
        url: 'https://weight-site.example.com',
        platform: 'new-api',
        externalCheckinUrl: 'ftp://invalid.example.com',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error?: string }).error).toContain('Invalid externalCheckinUrl');
  });

  it('updates per-site proxy settings for an existing site', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'toggle-site',
        url: 'https://toggle-site.example.com',
        platform: 'new-api',
        useSystemProxy: false,
      },
    });
    expect(created.statusCode).toBe(200);
    const site = created.json() as { id: number };

    const response = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}`,
      payload: {
        proxyUrl: 'http://127.0.0.1:8080',
        useSystemProxy: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as { proxyUrl?: string | null; useSystemProxy?: boolean };
    expect(payload.proxyUrl).toBe('http://127.0.0.1:8080');
    expect(payload.useSystemProxy).toBe(true);
  });

  it('returns a conflict response when updating a site to an existing platform and url', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'first-site',
        url: 'https://first-site.example.com',
        platform: 'new-api',
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'second-site',
        url: 'https://second-site.example.com',
        platform: 'new-api',
      },
    });
    expect(second.statusCode).toBe(200);

    const { id } = second.json() as { id: number };
    const response = await app.inject({
      method: 'PUT',
      url: `/api/sites/${id}`,
      payload: {
        url: 'https://first-site.example.com/',
        platform: 'new-api',
      },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error?: string }).error).toContain('already exists');
  });

  it('rejects invalid custom headers json', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'headers-site',
        url: 'https://headers-site.example.com',
        platform: 'new-api',
        customHeaders: '{invalid-json}',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error?: string }).error).toContain('Invalid customHeaders');
  });

  it('rejects custom headers with non-string values', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'headers-site',
        url: 'https://headers-site.example.com',
        platform: 'new-api',
        customHeaders: JSON.stringify({
          'x-site-scope': true,
        }),
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error?: string }).error).toContain('must use a string value');
  });
});
