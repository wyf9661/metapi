import type { FastifyInstance } from 'fastify';
import {
  clearAllProxyDebugTraces,
  getProxyDebugTraceDetail,
  listProxyDebugTraces,
} from '../../services/proxyDebugTraceStore.js';
import { normalizeProxyLogPageSize } from './stats.pure.js';

/**
 * Proxy debug trace endpoints, split out of statsRoutes. Registered by direct
 * call so the Fastify encapsulation context and auth hooks stay identical.
 */
export function registerStatsProxyDebugRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string } }>(
    '/api/stats/proxy-debug/traces',
    async (request) => {
      const limit = normalizeProxyLogPageSize(request.query.limit);
      const items = await listProxyDebugTraces({ limit });
      return { items };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/stats/proxy-debug/traces/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return reply
          .code(400)
          .send({ message: 'proxy debug trace id is invalid' });
      }

      const detail = await getProxyDebugTraceDetail(id);
      if (!detail) {
        return reply.code(404).send({ message: 'proxy debug trace not found' });
      }

      return detail;
    },
  );

  app.delete(
    '/api/stats/proxy-debug/traces',
    async () => {
      const result = await clearAllProxyDebugTraces();
      return {
        ok: true,
        ...result,
      };
    },
  );
}
