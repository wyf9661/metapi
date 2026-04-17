import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { handleOpenAiResponsesSurfaceRequest } from '../../proxy-core/surfaces/openAiResponsesSurface.js';
import { ensureResponsesWebsocketTransport } from './responsesWebsocket.js';

function resolveAliasedResponsesDownstreamPath(
  request: FastifyRequest,
): '/v1/responses' | '/v1/responses/compact' {
  const rawUrl = request.raw.url || request.url || '';
  const pathname = rawUrl.split('?')[0] || rawUrl;
  return pathname.endsWith('/compact')
    ? '/v1/responses/compact'
    : '/v1/responses';
}

export async function responsesProxyRoute(app: FastifyInstance) {
  ensureResponsesWebsocketTransport(app);

  app.post('/v1/responses', async (request: FastifyRequest, reply: FastifyReply) =>
    handleOpenAiResponsesSurfaceRequest(request, reply, '/v1/responses'));
  app.get('/v1/responses', async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(426).send({
      error: {
        message: 'WebSocket upgrade required for GET /v1/responses',
        type: 'invalid_request_error',
      },
    }));
  app.post('/v1/responses/compact', async (request: FastifyRequest, reply: FastifyReply) =>
    handleOpenAiResponsesSurfaceRequest(request, reply, '/v1/responses/compact'));

  app.post('/responses', async (request: FastifyRequest, reply: FastifyReply) =>
    handleOpenAiResponsesSurfaceRequest(request, reply, '/v1/responses'));
  app.post('/responses/*', async (request: FastifyRequest, reply: FastifyReply) =>
    handleOpenAiResponsesSurfaceRequest(request, reply, resolveAliasedResponsesDownstreamPath(request)));
  app.get('/responses', async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(426).send({
      error: {
        message: 'WebSocket upgrade required for GET /responses',
        type: 'invalid_request_error',
      },
    }));
}
