import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const handleOpenAiResponsesSurfaceRequestMock = vi.fn(async (_request, reply, downstreamPath) => (
  reply.code(200).send({
    ok: true,
    downstreamPath,
  })
));
const handleChatSurfaceRequestMock = vi.fn(async (_request, reply, downstreamFormat) => (
  reply.code(200).send({
    ok: true,
    downstreamFormat,
  })
));
const ensureResponsesWebsocketTransportMock = vi.fn();

vi.mock('../../proxy-core/surfaces/openAiResponsesSurface.js', () => ({
  handleOpenAiResponsesSurfaceRequest: (...args: unknown[]) => handleOpenAiResponsesSurfaceRequestMock(...args),
}));

vi.mock('../../proxy-core/surfaces/chatSurface.js', () => ({
  handleChatSurfaceRequest: (...args: unknown[]) => handleChatSurfaceRequestMock(...args),
  handleClaudeCountTokensSurfaceRequest: vi.fn(),
}));

vi.mock('./responsesWebsocket.js', () => ({
  ensureResponsesWebsocketTransport: (...args: unknown[]) => ensureResponsesWebsocketTransportMock(...args),
}));

describe('proxy route aliases', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { responsesProxyRoute } = await import('./responses.js');
    const { chatProxyRoute } = await import('./chat.js');
    app = Fastify();
    await app.register(responsesProxyRoute);
    await app.register(chatProxyRoute);
  });

  beforeEach(() => {
    handleOpenAiResponsesSurfaceRequestMock.mockClear();
    handleChatSurfaceRequestMock.mockClear();
    ensureResponsesWebsocketTransportMock.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers bare responses aliases against the same downstream handlers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/responses',
      payload: { model: 'gpt-5.2', input: 'hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(handleOpenAiResponsesSurfaceRequestMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({
      ok: true,
      downstreamPath: '/v1/responses',
    });
  });

  it('routes bare compact responses aliases to compact downstream path', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/responses/compact',
      payload: { model: 'gpt-5.2', input: 'hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(handleOpenAiResponsesSurfaceRequestMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({
      ok: true,
      downstreamPath: '/v1/responses/compact',
    });
  });

  it('returns websocket upgrade required for bare GET /responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/responses',
    });

    expect(response.statusCode).toBe(426);
    expect(handleOpenAiResponsesSurfaceRequestMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: {
        message: 'WebSocket upgrade required for GET /v1/responses',
        type: 'invalid_request_error',
      },
    });
  });

  it('rejects unknown /responses alias subpaths instead of silently rewriting them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/responses/other',
      payload: { model: 'gpt-5.2', input: 'hello' },
    });

    expect(response.statusCode).toBe(404);
    expect(handleOpenAiResponsesSurfaceRequestMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: {
        message: 'Unknown /responses alias path',
        type: 'invalid_request_error',
      },
    });
  });

  it('keeps GET /responses/compact aligned with the websocket upgrade path', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/responses/compact',
    });

    expect(response.statusCode).toBe(426);
    expect(handleOpenAiResponsesSurfaceRequestMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: {
        message: 'WebSocket upgrade required for GET /v1/responses/compact',
        type: 'invalid_request_error',
      },
    });
  });

  it('registers bare chat completions alias against the openai chat handler', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      payload: { model: 'gpt-5.2', messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(response.statusCode).toBe(200);
    expect(handleChatSurfaceRequestMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toEqual({
      ok: true,
      downstreamFormat: 'openai',
    });
  });
});
