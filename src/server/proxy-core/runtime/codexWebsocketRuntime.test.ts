import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

describe('codexWebsocketRuntime', () => {
  let upstreamServer: WebSocketServer;
  let upstreamWsUrl: string;
  let upstreamConnectionCount = 0;
  let upstreamRequests: Record<string, unknown>[] = [];

  beforeAll(async () => {
    upstreamServer = new WebSocketServer({ port: 0 });
    upstreamServer.on('connection', (socket) => {
      upstreamConnectionCount += 1;
      socket.on('message', (payload) => {
        const parsed = JSON.parse(String(payload)) as Record<string, unknown>;
        upstreamRequests.push(parsed);
        const responseId = `resp-${upstreamRequests.length}`;
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: {
            id: responseId,
            object: 'response',
            model: parsed.model || 'gpt-5.4',
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
            },
          },
        }));
      });
    });
    await new Promise<void>((resolve) => upstreamServer.once('listening', () => resolve()));
    const address = upstreamServer.address() as AddressInfo;
    upstreamWsUrl = `ws://127.0.0.1:${address.port}/backend-api/codex/responses`;
  });

  beforeEach(() => {
    upstreamConnectionCount = 0;
    upstreamRequests = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  it('reuses the same upstream websocket connection across turns for one execution session', async () => {
    const { createCodexWebsocketRuntime } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();

    const first = await runtime.sendRequest({
      sessionId: 'exec-session-1',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        input: [],
      },
    });

    const second = await runtime.sendRequest({
      sessionId: 'exec-session-1',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        previous_response_id: 'resp-1',
        input: [],
      },
    });

    expect(first.events[0]).toMatchObject({
      type: 'response.completed',
      response: { id: 'resp-1' },
    });
    expect(second.events[0]).toMatchObject({
      type: 'response.completed',
      response: { id: 'resp-2' },
    });
    expect(upstreamConnectionCount).toBe(1);
    expect(upstreamRequests).toHaveLength(2);
    expect(upstreamRequests[0]).toMatchObject({
      type: 'response.create',
      model: 'gpt-5.4',
    });
    expect(upstreamRequests[1]).toMatchObject({
      type: 'response.create',
      previous_response_id: 'resp-1',
    });

    await runtime.closeSession('exec-session-1');
  });

  it('closes the upstream websocket when the execution session is closed explicitly', async () => {
    const { createCodexWebsocketRuntime } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();

    await runtime.sendRequest({
      sessionId: 'exec-session-close',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        input: [],
      },
    });
    await runtime.closeSession('exec-session-close');

    await runtime.sendRequest({
      sessionId: 'exec-session-close',
      requestUrl: upstreamWsUrl,
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06',
      },
      body: {
        model: 'gpt-5.4',
        input: [],
      },
    });

    expect(upstreamConnectionCount).toBe(2);
    await runtime.closeSession('exec-session-close');
  });
});
