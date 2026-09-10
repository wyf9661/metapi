import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('peer overview route', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-peer-route-'));
    process.env.AUTH_TOKEN = 'peer-test-admin-token';
    // Rebuild config after setting AUTH_TOKEN (config is a build-time singleton).
    const { config: rebuilt } = await import('../../config.js');
    (rebuilt as { authToken: string }).authToken = 'peer-test-admin-token';

    await import('../../db/migrate.js');
    const routesModule = await import('./peer.js');

    app = Fastify();
    await app.register(routesModule.peerRoutes);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('answers a bare featureless 401 without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/peer/overview' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-metapi-peer']).toBeUndefined();
    expect(res.body).not.toContain('metapi');
    expect(res.body).not.toContain('peer/overview');
  });

  it('answers a featureless 401 for a downstream sk- key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/peer/overview',
      headers: { authorization: 'Bearer sk-cascade-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-metapi-peer']).toBeUndefined();
  });

  it('answers a featureless 401 for a wrong admin token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/peer/overview',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe(JSON.stringify({ error: 'Invalid token' }));
  });

  it('returns the site-level overview for the admin token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/peer/overview',
      headers: { authorization: 'Bearer peer-test-admin-token' },
    });
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.protocolVersion).toBe(1);
    expect(payload.site).toEqual({
      totalBalance: expect.any(Number),
      totalUsed: expect.any(Number),
      activeAccounts: expect.any(Number),
      totalAccounts: expect.any(Number),
    });
    expect(payload.today).toEqual({
      spend: expect.any(Number),
      reward: expect.any(Number),
      checkin: expect.any(Object),
    });
    expect(typeof payload.updatedAt).toBe('string');
  });
});
