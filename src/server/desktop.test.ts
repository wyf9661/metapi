import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { isPublicApiRoute, registerDesktopRoutes } from './desktop.js';

describe('desktop server routes', () => {
  it('marks only the desktop health route as public', () => {
    expect(isPublicApiRoute('/api/desktop/health')).toBe(true);
    expect(isPublicApiRoute('/api/health/live')).toBe(true);
    expect(isPublicApiRoute('/api/health/ready')).toBe(true);
    expect(isPublicApiRoute('/api/stats/dashboard')).toBe(false);
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
