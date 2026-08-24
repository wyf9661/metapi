import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const listRemoteUpstreamModelsMock = vi.fn();
const testRemoteUpstreamProtocolMock = vi.fn();

vi.mock('../../services/remoteUpstreamTester.js', () => ({
  listRemoteUpstreamModels: (...args: unknown[]) => listRemoteUpstreamModelsMock(...args),
  testRemoteUpstreamProtocol: (...args: unknown[]) => testRemoteUpstreamProtocolMock(...args),
}));

describe('/api/test/remote routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { testRoutes } = await import('./test.js');
    app = Fastify();
    await app.register(testRoutes);
  });

  beforeEach(() => {
    listRemoteUpstreamModelsMock.mockReset();
    testRemoteUpstreamProtocolMock.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists remote models and returns structured result on HTTP 200', async () => {
    listRemoteUpstreamModelsMock.mockResolvedValue({
      ok: true,
      statusCode: 200,
      latencyMs: 12,
      requestUrl: 'https://api.example.com/v1/models',
      requestHeaders: { authorization: '***' },
      responseHeaders: {},
      responseBody: { data: [{ id: 'gpt-4o-mini' }] },
      responseText: '{"data":[{"id":"gpt-4o-mini"}]}',
      models: ['gpt-4o-mini'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/remote/models',
      payload: {
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      models: ['gpt-4o-mini'],
    });
    expect(listRemoteUpstreamModelsMock).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      timeoutMs: undefined,
    });
  });

  it('passes an empty API key through for keyless upstreams', async () => {
    listRemoteUpstreamModelsMock.mockResolvedValue({
      ok: true,
      statusCode: 200,
      latencyMs: 3,
      requestUrl: 'http://127.0.0.1:4096/v1/models',
      requestHeaders: { 'content-type': 'application/json' },
      responseHeaders: {},
      responseBody: { data: [{ id: 'opencode/local-model' }] },
      responseText: '{"data":[{"id":"opencode/local-model"}]}',
      models: ['opencode/local-model'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/remote/models',
      payload: {
        baseUrl: 'http://127.0.0.1:4096',
        apiKey: '',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      models: ['opencode/local-model'],
    });
    expect(listRemoteUpstreamModelsMock).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:4096',
      apiKey: '',
      timeoutMs: undefined,
    });
  });

  it('probes a remote protocol and still returns HTTP 200 when ok=false', async () => {
    testRemoteUpstreamProtocolMock.mockResolvedValue({
      ok: false,
      statusCode: 401,
      latencyMs: 8,
      requestUrl: 'https://api.example.com/v1/chat/completions',
      requestHeaders: { authorization: '***' },
      requestBody: { model: 'gpt-4o-mini' },
      responseHeaders: {},
      responseBody: { error: { message: 'invalid key' } },
      responseText: '{"error":{"message":"invalid key"}}',
      error: 'HTTP 401',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/remote/probe',
      payload: {
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-bad',
        protocol: 'completion',
        model: 'gpt-4o-mini',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      statusCode: 401,
      error: 'HTTP 401',
    });
  });

  it('returns 400 for validation errors from the probe service', async () => {
    testRemoteUpstreamProtocolMock.mockRejectedValue(new Error('model is required'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/test/remote/probe',
      payload: {
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test',
        protocol: 'completion',
        model: '',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: 'model is required',
    });
  });
});
