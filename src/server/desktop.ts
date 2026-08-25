import type { FastifyInstance } from 'fastify';
import { config } from './config.js';

const DESKTOP_HEALTH_ROUTE = '/api/desktop/health';
const LIVE_HEALTH_ROUTE = '/api/health/live';
const READY_HEALTH_ROUTE = '/api/health/ready';
// Desktop first-run bootstrap: login screen reads the synthesized admin token
// before the user has changed it (see GET /api/settings/auth/info in auth.ts).
// Must be reachable without auth on desktop so the user can learn the value and
// sign in once. On server installs (METAPI_DESKTOP unset) it returns no token.
const AUTH_INFO_ROUTE = '/api/settings/auth/info';
// Exposes the actual local listen address (port may be auto-fallback when 4000
// is taken). Used by the settings page so desktop/server users can copy their
// base URL for Cursor / Codex / OpenAI SDK configuration.
const DESKTOP_INFO_ROUTE = '/api/desktop/info';
const FAVICON_PROXY_ROUTE = '/api/site-favicon';
const BRAND_ICON_PROXY_ROUTE = '/api/brand-icon';

export function isPublicApiRoute(url: string): boolean {
  const path = (url || '').split('?')[0] || '';
  return path === DESKTOP_HEALTH_ROUTE
    || path === LIVE_HEALTH_ROUTE
    || path === READY_HEALTH_ROUTE
    || path === AUTH_INFO_ROUTE
    || path === DESKTOP_INFO_ROUTE
    || path === FAVICON_PROXY_ROUTE
    || path === BRAND_ICON_PROXY_ROUTE
    || path.startsWith('/api/oauth/callback/');
}

export async function registerDesktopRoutes(
  app: FastifyInstance,
  deps: { checkReady?: () => Promise<boolean> } = {},
) {
  app.get(DESKTOP_HEALTH_ROUTE, async () => ({ ok: true }));
  app.get(LIVE_HEALTH_ROUTE, async () => ({ ok: true }));
  app.get(READY_HEALTH_ROUTE, async (_request, reply) => {
    try {
      const ready = deps.checkReady ? await deps.checkReady() : true;
      return reply.code(ready ? 200 : 503).send({ ok: ready, ready });
    } catch {
      return reply.code(503).send({ ok: false, ready: false });
    }
  });
  app.get(DESKTOP_INFO_ROUTE, async () => {
    const host = (config.listenHost || '127.0.0.1').trim();
    const normalizedHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return {
      baseUrl: `http://${normalizedHost}:${config.port}`,
      port: config.port,
      host: config.listenHost,
      desktop: process.env.METAPI_DESKTOP === '1',
    };
  });
}
