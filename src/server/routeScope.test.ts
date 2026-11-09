import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicApiRoute } from './desktop.js';
import { REQUEST_BODY_UPLOAD_ROUTE_PREFIX } from './services/requestBodyChunkedUpload.js';
import { resolveRequestRouteScope, resolveRequestUrlPath } from './routeScope.js';

/**
 * The admin gate used to key off the RAW request URL
 * (`request.url.startsWith('/api/')`) while find-my-way matches on the DECODED
 * path, so `/%61pi/sites` reached the real admin route without ever entering
 * authMiddleware. These tests pin the gate to what the router actually matched
 * and run the real gate against a real router, encoded and traversal forms
 * included.
 */
describe('resolveRequestUrlPath', () => {
  it('decodes percent-encoded paths the way the router does', () => {
    expect(resolveRequestUrlPath('/%61pi/sites')).toBe('/api/sites');
    expect(resolveRequestUrlPath('/ap%69/sites')).toBe('/api/sites');
  });

  it('falls back to the raw path when the escape is malformed', () => {
    expect(resolveRequestUrlPath('/%zz')).toBe('/%zz');
  });

  it('drops the query string', () => {
    expect(resolveRequestUrlPath('/api/events?limit=30')).toBe('/api/events');
  });
});

describe('resolveRequestRouteScope', () => {
  const scope = (rawUrl: string, matchedRoute: string | undefined) =>
    resolveRequestRouteScope(rawUrl, matchedRoute, {
      isPublicApiRoute,
      uploadRoutePrefix: REQUEST_BODY_UPLOAD_ROUTE_PREFIX,
    });

  it('requires admin auth for a management route reached through encoded segments', () => {
    expect(scope('/%61pi/sites', '/api/sites')).toBe('admin');
    expect(scope('/ap%69/sites', '/api/sites')).toBe('admin');
    expect(scope('/api/%2e%2e/api/sites', '/api/sites')).toBe('admin');
    expect(scope('/api/settings/backup/export', '/api/settings/backup/export')).toBe('admin');
  });

  it('keeps the public and self-authenticating exemptions reachable by encoded path', () => {
    expect(scope('/%61pi/health/live', '/api/health/live')).toBe('public');
    expect(scope('/%61pi/oauth/callback/github', '/api/oauth/callback/:provider')).toBe('public');
    expect(scope('/%61pi/v1/peer/body-upload', '/api/v1/peer/body-upload/*')).toBe('upload');
  });

  it('leaves non-/api routes to the proxy and static surfaces', () => {
    expect(scope('/v1/chat/completions', '/v1/chat/completions')).toBe('other');
    expect(scope('/logo.svg', '/*')).toBe('other');
  });
});

describe('onRequest admin gate against a real router', () => {
  let app: FastifyInstance;
  let port = 0;

  beforeAll(async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'metapi-gate-'));
    writeFileSync(join(staticRoot, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    app = Fastify({ logger: false });
    // Same gate the server installs, minus the tunnel branch (covered separately
    // in tunnelAccessPolicy.test.ts).
    app.addHook('onRequest', async (request, reply) => {
      const scope = resolveRequestRouteScope(request.url, request.routeOptions?.url, {
        isPublicApiRoute,
        uploadRoutePrefix: REQUEST_BODY_UPLOAD_ROUTE_PREFIX,
      });
      if (scope === 'admin' && !request.headers.authorization) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });
    app.get('/api/sites', async () => ({ reached: true, by: 'router' }));
    app.get('/api/settings/auth/info', async () => ({ reached: true, by: 'router' }));
    app.get('/api/health/live', async () => ({ ok: true }));
    await app.register(fastifyStatic, { root: staticRoot, prefix: '/', wildcard: true });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = app.server.address().port as number;
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);

  it('refuses encoded and traversal forms of a management route without credentials', async () => {
    for (const path of [
      '/api/sites',
      '/%61pi/sites',
      '/ap%69/sites',
      '/api/%2e%2e/api/sites',
      '/api/../api/sites',
    ]) {
      expect((await get(path)).status, path).toBe(401);
    }
  });

  it('keeps routes that are public by design public, encoded or not', async () => {
    // auth/info is in the public allowlist (masked token only on server builds);
    // the gate must not start refusing it just because the path is escaped.
    expect((await get('/%61pi/settings/auth/info')).status).toBe(200);
  });

  it('still serves public routes and static assets', async () => {
    expect((await get('/api/health/live')).status).toBe(200);
    expect((await get('/logo.svg')).status).toBe(200);
  });
});
