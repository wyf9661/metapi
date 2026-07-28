import type { FastifyInstance } from 'fastify';

const DESKTOP_HEALTH_ROUTE = '/api/desktop/health';
const LIVE_HEALTH_ROUTE = '/api/health/live';
const READY_HEALTH_ROUTE = '/api/health/ready';

export function isPublicApiRoute(url: string): boolean {
  return url === DESKTOP_HEALTH_ROUTE
    || url === LIVE_HEALTH_ROUTE
    || url === READY_HEALTH_ROUTE
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
