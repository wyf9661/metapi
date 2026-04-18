import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { handleOpenAiResponsesSurfaceRequest } from '../../proxy-core/surfaces/openAiResponsesSurface.js';
import { ensureResponsesWebsocketTransport } from './responsesWebsocket.js';

function resolveAliasedResponsesDownstreamPath(
  request: FastifyRequest,
): '/v1/responses' | '/v1/responses/compact' | null {
  const rawUrl = request.raw.url || request.url || '';
  const pathname = rawUrl.split('?')[0] || rawUrl;
  if (pathname === '/responses') return '/v1/responses';
  return pathname.endsWith('/compact')
    ? '/v1/responses/compact'
    : null;
}

async function replyUnsupportedAliasedResponsesPath(reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      message: 'Unknown /responses alias path',
      type: 'invalid_request_error',
    },
  });
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
  app.post('/responses/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const downstreamPath = resolveAliasedResponsesDownstreamPath(request);
    if (!downstreamPath) {
      return replyUnsupportedAliasedResponsesPath(reply);
    }
    return handleOpenAiResponsesSurfaceRequest(request, reply, downstreamPath);
  });
  app.get('/responses', async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(426).send({
      error: {
        message: 'WebSocket upgrade required for GET /v1/responses',
        type: 'invalid_request_error',
      },
    }));
  app.get('/responses/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const downstreamPath = resolveAliasedResponsesDownstreamPath(request);
    if (!downstreamPath) {
      return replyUnsupportedAliasedResponsesPath(reply);
    }
    return reply.code(426).send({
      error: {
        message: `WebSocket upgrade required for GET ${downstreamPath}`,
        type: 'invalid_request_error',
      },
    });
  });
}
