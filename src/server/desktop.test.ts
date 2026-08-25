import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { isPublicApiRoute, registerDesktopRoutes } from './desktop.js';

describe('desktop server routes', () => {
  it('marks only the desktop health / bootstrap routes as public', () => {
    expect(isPublicApiRoute('/api/desktop/health')).toBe(true);
    expect(isPublicApiRoute('/api/health/live')).toBe(true);
    expect(isPublicApiRoute('/api/health/ready')).toBe(true);
    expect(isPublicApiRoute('/api/settings/auth/info')).toBe(true);
    expect(isPublicApiRoute('/api/stats/dashboard')).toBe(false);
  });

  it('treats query strings as part of the same route', () => {
    expect(
      isPublicApiRoute('/api/site-favicon?url=https%3A%2F%2Fexample.com'),
    ).toBe(true);
    expect(isPublicApiRoute('/api/site-favicon')).toBe(true);
    expect(
      isPublicApiRoute('/api/oauth/callback/new-api?code=abc&state=xyz'),
    ).toBe(true);
    expect(isPublicApiRoute('/api/site-favicon-other')).toBe(false);
  });

  it('registers public liveness and readiness probes', async () => {
    const app = Fastify();
    await registerDesktopRoutes(app, { checkReady: async () => true });
    expect((await app.inject('/api/health/live')).statusCode).toBe(200);
    expect((await app.inject('/api/health/ready')).json()).toEqual({ ok: true, ready: true });
    await app.close();
  });

  it('registers a public desktop health probe', async () => {
    const app = Fastify();
    await registerDesktopRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/desktop/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
