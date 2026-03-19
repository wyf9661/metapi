import Fastify, { type FastifyInstance } from 'fastify';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const previewSelectedChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn(async ({ usage }: any) => ({
  ...usage,
  estimatedCostFromQuota: 0,
  recoveredFromSelfLog: false,
}));
const dbInsertMock = vi.fn((_arg?: any) => ({
  values: () => ({
    run: () => undefined,
  }),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    previewSelectedChannel: (...args: unknown[]) => previewSelectedChannelMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: () => false,
}));

vi.mock('../../services/modelPricingService.js', () => ({
  estimateProxyCost: async () => 0,
  buildProxyBillingDetails: async () => null,
  fetchModelPricingCatalog: async () => null,
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: () => false,
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (arg: any) => resolveProxyUsageWithSelfLogFallbackMock(arg),
}));

vi.mock('../../services/oauth/quota.js', () => ({
  recordOauthQuotaResetHint: async () => undefined,
}));

vi.mock('../../db/index.js', () => ({
  db: {
    insert: (arg: any) => dbInsertMock(arg),
  },
  hasProxyLogDownstreamApiKeyIdColumn: async () => false,
  schema: {
    proxyLogs: {},
  },
}));

function createSseResponse(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }), {
    status,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function createSelectedChannel(options?: {
  siteName?: string;
  siteUrl?: string;
  sitePlatform?: string;
  username?: string;
  extraConfig?: string;
  tokenValue?: string;
  actualModel?: string;
}) {
  const sitePlatform = options?.sitePlatform ?? 'codex';
  const isCodex = sitePlatform === 'codex';
  return {
    channel: { id: 11, routeId: 22 },
    site: {
      name: options?.siteName ?? (isCodex ? 'codex-site' : 'openai-site'),
      url: options?.siteUrl ?? (isCodex ? 'https://chatgpt.com/backend-api/codex' : 'https://api.openai.com'),
      platform: sitePlatform,
    },
    account: {
      id: 33,
      username: options?.username ?? (isCodex ? 'codex-user@example.com' : 'openai-user@example.com'),
      extraConfig: options?.extraConfig ?? (isCodex
        ? JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'codex',
            accountId: 'chatgpt-account-123',
            email: 'codex-user@example.com',
          },
        })
        : '{}'),
    },
    tokenName: 'default',
    tokenValue: options?.tokenValue ?? (isCodex ? 'oauth-access-token' : 'sk-openai-token'),
    actualModel: options?.actualModel ?? (isCodex ? 'gpt-5.4' : 'gpt-4.1'),
  };
}

function waitForSocketOpen(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function waitForSocketUpgrade(socket: WebSocket) {
  return new Promise<{ headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    socket.once('upgrade', (response) => resolve({ headers: response.headers as Record<string, string | string[] | undefined> }));
    socket.once('error', reject);
  });
}

function waitForSocketMessages(socket: WebSocket, count: number, timeoutMs = 1000) {
  return new Promise<any[]>((resolve, reject) => {
    const messages: any[] = [];
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      socket.off('error', onError);
      reject(new Error(`Timed out waiting for ${count} websocket messages`));
    }, timeoutMs);
    const onMessage = (payload: WebSocket.RawData) => {
      messages.push(JSON.parse(String(payload)));
      if (messages.length >= count) {
        clearTimeout(timeout);
        socket.off('message', onMessage);
        socket.off('error', onError);
        resolve(messages);
      }
    };
    const onError = (error: Error) => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      reject(error);
    };
    socket.on('message', onMessage);
    socket.once('error', onError);
  });
}

describe('responses websocket transport', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    const { responsesProxyRoute } = await import('./responses.js');
    app = Fastify();
    await app.register(responsesProxyRoute);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    previewSelectedChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    resolveProxyUsageWithSelfLogFallbackMock.mockClear();
    dbInsertMock.mockClear();

    const selectedChannel = createSelectedChannel();
    selectChannelMock.mockReturnValue(selectedChannel);
    selectNextChannelMock.mockReturnValue(null);
    previewSelectedChannelMock.mockResolvedValue(selectedChannel);
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts response.create over GET /v1/responses websocket and forwards streamed responses events', async () => {
    fetchMock.mockResolvedValue(createSseResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_ws","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_ws","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_ws","delta":"pong"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_ws","model":"gpt-5.4","status":"completed","output":[{"id":"msg_ws","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"pong"}]}],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const socket = new WebSocket(`${baseUrl}/v1/responses`);
    await waitForSocketOpen(socket);
    const messagesPromise = waitForSocketMessages(socket, 4);

    socket.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-5.4',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello websocket' }],
        },
      ],
    }));

    const messages = await messagesPromise;
    socket.close();

    expect(messages.map((message) => message.type)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.completed',
    ]);
    expect(messages[3]?.response?.output?.[0]?.content?.[0]?.text).toBe('pong');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('echoes x-codex-turn-state on websocket upgrade responses', async () => {
    const socket = new WebSocket(`${baseUrl}/v1/responses`, {
      headers: {
        'x-codex-turn-state': 'turn-state-123',
      },
    });

    const [upgrade] = await Promise.all([
      waitForSocketUpgrade(socket),
      waitForSocketOpen(socket),
    ]);
    socket.close();

    expect(upgrade.headers['x-codex-turn-state']).toBe('turn-state-123');
  });

  it('merges follow-up response.create payloads when the selected upstream does not support incremental mode', async () => {
    const selectedChannel = createSelectedChannel({
      sitePlatform: 'openai',
      actualModel: 'gpt-4.1',
    });
    selectChannelMock.mockReturnValue(selectedChannel);
    previewSelectedChannelMock.mockResolvedValue(selectedChannel);
    fetchMock
      .mockResolvedValueOnce(createSseResponse([
        'event: response.output_item.done\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1"}}\n\n',
        'event: response.output_item.done\n',
        'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"call tool"}]}}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_ws_1","model":"gpt-4.1","status":"completed","output":[{"id":"fc_1","type":"function_call","call_id":"call_1"},{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"call tool"}]}],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
        'data: [DONE]\n\n',
      ]))
      .mockResolvedValueOnce(createSseResponse([
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_ws_2","model":"gpt-4.1","status":"completed","output":[{"id":"msg_2","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]}],"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}\n\n',
        'data: [DONE]\n\n',
      ]));

    const socket = new WebSocket(`${baseUrl}/v1/responses`);
    await waitForSocketOpen(socket);

    const firstResponsePromise = waitForSocketMessages(socket, 1);
    socket.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-4.1',
      instructions: 'be helpful',
      input: [
        {
          id: 'msg_user_1',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'call the tool' }],
        },
      ],
    }));
    await firstResponsePromise;

    const secondResponsePromise = waitForSocketMessages(socket, 1);
    socket.send(JSON.stringify({
      type: 'response.create',
      previous_response_id: 'resp_ws_1',
      input: [
        {
          id: 'tool_out_1',
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'tool result',
        },
      ],
    }));
    await secondResponsePromise;
    socket.close();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, firstOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    const firstBody = JSON.parse(String(firstOptions.body));
    const secondBody = JSON.parse(String(secondOptions.body));

    expect(firstBody.input).toHaveLength(1);
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.model).toBe('gpt-4.1');
    expect(secondBody.instructions).toBe('be helpful');
    expect(secondBody.input).toEqual([
      {
        id: 'msg_user_1',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'call the tool' }],
      },
      {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        status: 'completed',
      },
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'call tool' }],
      },
      {
        id: 'tool_out_1',
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'tool result',
      },
    ]);
  });

  it('preserves incremental response.create payloads with previous_response_id for websocket-capable upstreams', async () => {
    fetchMock
      .mockResolvedValueOnce(createSseResponse([
        'event: response.output_item.done\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1"}}\n\n',
        'event: response.output_item.done\n',
        'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"call tool"}]}}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_ws_1","model":"gpt-5.4","status":"completed","output":[{"id":"fc_1","type":"function_call","call_id":"call_1"},{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"call tool"}]}],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
        'data: [DONE]\n\n',
      ]))
      .mockResolvedValueOnce(createSseResponse([
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_ws_2","model":"gpt-5.4","status":"completed","output":[{"id":"msg_2","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]}],"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}\n\n',
        'data: [DONE]\n\n',
      ]));

    const socket = new WebSocket(`${baseUrl}/v1/responses`);
    await waitForSocketOpen(socket);

    const firstResponsePromise = waitForSocketMessages(socket, 1);
    socket.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-5.4',
      instructions: 'be helpful',
      input: [
        {
          id: 'msg_user_1',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'call the tool' }],
        },
      ],
    }));
    await firstResponsePromise;

    const secondResponsePromise = waitForSocketMessages(socket, 1);
    socket.send(JSON.stringify({
      type: 'response.create',
      previous_response_id: 'resp_ws_1',
      input: [
        {
          id: 'tool_out_1',
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'tool result',
        },
      ],
    }));
    await secondResponsePromise;
    socket.close();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(String(secondOptions.body));
    expect(secondBody.previous_response_id).toBe('resp_ws_1');
    expect(secondBody.model).toBe('gpt-5.4');
    expect(secondBody.instructions).toBe('be helpful');
    expect(secondBody.input).toEqual([
      {
        id: 'tool_out_1',
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'tool result',
      },
    ]);
  });

  it('handles generate=false locally only for non-websocket-capable upstreams', async () => {
    const selectedChannel = createSelectedChannel({
      sitePlatform: 'openai',
      actualModel: 'gpt-4.1',
    });
    selectChannelMock.mockReturnValue(selectedChannel);
    previewSelectedChannelMock.mockResolvedValue(selectedChannel);
    fetchMock.mockResolvedValueOnce(createSseResponse([
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_ws_after_prewarm","model":"gpt-4.1","status":"completed","output":[{"id":"msg_2","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const socket = new WebSocket(`${baseUrl}/v1/responses`);
    await waitForSocketOpen(socket);

    const prewarmMessagesPromise = waitForSocketMessages(socket, 2);
    socket.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-4.1',
      generate: false,
    }));
    const prewarmMessages = await prewarmMessagesPromise;
    expect(prewarmMessages.map((message) => message.type)).toEqual(['response.created', 'response.completed']);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    const secondResponsePromise = waitForSocketMessages(socket, 1);
    socket.send(JSON.stringify({
      type: 'response.create',
      previous_response_id: prewarmMessages[0]?.response?.id,
      input: [
        {
          id: 'msg_followup_1',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      ],
    }));
    await secondResponsePromise;
    socket.close();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwardedBody = JSON.parse(String(options.body));
    expect(forwardedBody.generate).toBeUndefined();
    expect(forwardedBody.previous_response_id).toBeUndefined();
    expect(forwardedBody.model).toBe('gpt-4.1');
    expect(forwardedBody.input).toEqual([
      {
        id: 'msg_followup_1',
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue' }],
      },
    ]);
  });

  it('forwards generate=false upstream for websocket-capable upstreams instead of synthesizing prewarm events', async () => {
    fetchMock.mockResolvedValueOnce(createSseResponse([
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_capable_generate_false","model":"gpt-5.4","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const socket = new WebSocket(`${baseUrl}/v1/responses`);
    await waitForSocketOpen(socket);
    const messagesPromise = waitForSocketMessages(socket, 1);

    socket.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-5.4',
      generate: false,
    }));

    const messages = await messagesPromise;
    socket.close();

    expect(messages.map((message) => message.type)).toEqual(['response.completed']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const forwardedBody = JSON.parse(String(options.body));
    expect(forwardedBody.generate).toBe(false);
  });

  it('emits websocket error when the upstream stream closes before a terminal responses event', async () => {
    fetchMock.mockResolvedValue(createSseResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_incomplete","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_ws","delta":"partial"}\n\n',
    ]));

    const socket = new WebSocket(`${baseUrl}/v1/responses`);
    await waitForSocketOpen(socket);
    const messagesPromise = waitForSocketMessages(socket, 6, 400);

    socket.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-5.4',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello websocket' }],
        },
      ],
    }));

    const messages = await messagesPromise;
    socket.close();

    expect(messages.map((message) => message.type)).toEqual([
      'response.created',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.failed',
    ]);
    expect(messages[5]?.response?.status).toBe('failed');
    expect(messages[5]?.error?.message).toContain('stream closed before response.completed');
  });
});
