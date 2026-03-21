import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

describe('codexWebsocketRuntime', () => {
  let upstreamServer: WebSocketServer;
  let upstreamWsUrl: string;
  let upstreamConnectionCount = 0;
  let upstreamRequests: Record<string, unknown>[] = [];
  let upstreamMessageHandler: (socket: import('ws').WebSocket, parsed: Record<string, unknown>, requestIndex: number) => void;

  beforeAll(async () => {
    upstreamServer = new WebSocketServer({ port: 0 });
    upstreamServer.on('connection', (socket) => {
      upstreamConnectionCount += 1;
      socket.on('message', (payload) => {
        const parsed = JSON.parse(String(payload)) as Record<string, unknown>;
        upstreamRequests.push(parsed);
        upstreamMessageHandler(socket, parsed, upstreamRequests.length);
      });
    });
    await new Promise<void>((resolve) => upstreamServer.once('listening', () => resolve()));
    const address = upstreamServer.address() as AddressInfo;
    upstreamWsUrl = `ws://127.0.0.1:${address.port}/backend-api/codex/responses`;
  });

  beforeEach(() => {
    upstreamConnectionCount = 0;
    upstreamRequests = [];
    upstreamMessageHandler = (socket, parsed, requestIndex) => {
      const responseId = `resp-${requestIndex}`;
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
    };
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

  it('treats response.incomplete as a terminal websocket failure instead of waiting for socket close', async () => {
    upstreamMessageHandler = (socket, parsed) => {
      socket.send(JSON.stringify({
        type: 'response.incomplete',
        response: {
          id: 'resp-incomplete',
          model: parsed.model || 'gpt-5.4',
          status: 'incomplete',
          incomplete_details: {
            reason: 'max_output_tokens',
          },
        },
      }));
    };

    const { createCodexWebsocketRuntime, CodexWebsocketRuntimeError } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();

    let error: unknown;
    try {
      await runtime.sendRequest({
        sessionId: 'exec-session-incomplete',
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
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CodexWebsocketRuntimeError);
    expect(error).toMatchObject({
      message: 'max_output_tokens',
      status: 502,
    });
    expect((error as CodexWebsocketRuntimeError).events).toEqual([
      expect.objectContaining({
        type: 'response.incomplete',
      }),
    ]);
  });

  it('treats top-level error frames as terminal websocket failures', async () => {
    upstreamMessageHandler = (socket) => {
      socket.send(JSON.stringify({
        type: 'error',
        error: {
          message: 'account mismatch',
          type: 'invalid_request_error',
        },
      }));
    };

    const { createCodexWebsocketRuntime, CodexWebsocketRuntimeError } = await import('./codexWebsocketRuntime.js');
    const runtime = createCodexWebsocketRuntime();

    let error: unknown;
    try {
      await runtime.sendRequest({
        sessionId: 'exec-session-error',
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
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CodexWebsocketRuntimeError);
    expect(error).toMatchObject({
      message: 'account mismatch',
      status: 502,
    });
    expect((error as CodexWebsocketRuntimeError).events).toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({
          message: 'account mismatch',
        }),
      }),
    ]);
  });
});
