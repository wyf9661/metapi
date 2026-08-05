import type { FastifyInstance } from 'fastify';

const DESKTOP_HEALTH_ROUTE = '/api/desktop/health';
const LIVE_HEALTH_ROUTE = '/api/health/live';
const READY_HEALTH_ROUTE = '/api/health/ready';
// Desktop first-run bootstrap: login screen reads the synthesized admin token
// before the user has changed it (see GET /api/settings/auth/info in auth.ts).
// Must be reachable without auth on desktop so the user can learn the value and
// sign in once. On server installs (METAPI_DESKTOP unset) it returns no token.
const AUTH_INFO_ROUTE = '/api/settings/auth/info';

export function isPublicApiRoute(url: string): boolean {
  return url === DESKTOP_HEALTH_ROUTE
    || url === LIVE_HEALTH_ROUTE
    || url === READY_HEALTH_ROUTE
    || url === AUTH_INFO_ROUTE
    || url.startsWith('/api/oauth/callback/');
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
}
