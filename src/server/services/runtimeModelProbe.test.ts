import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveUpstreamEndpointCandidatesMock = vi.fn();
const buildUpstreamEndpointRequestMock = vi.fn();
const dispatchRuntimeRequestMock = vi.fn();
const resolveChannelProxyUrlMock = vi.fn();
const withSiteRecordProxyRequestInitMock = vi.fn();
const getOauthInfoFromAccountMock = vi.fn();
const buildOauthProviderHeadersMock = vi.fn();

vi.mock('./upstreamEndpointRuntime.js', () => ({
  resolveUpstreamEndpointCandidates: (...args: unknown[]) => resolveUpstreamEndpointCandidatesMock(...args),
  buildUpstreamEndpointRequest: (...args: unknown[]) => buildUpstreamEndpointRequestMock(...args),
}));

vi.mock('./runtimeDispatch.js', () => ({
  dispatchRuntimeRequest: (...args: unknown[]) => dispatchRuntimeRequestMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  resolveChannelProxyUrl: (...args: unknown[]) => resolveChannelProxyUrlMock(...args),
  withSiteRecordProxyRequestInit: (...args: unknown[]) => withSiteRecordProxyRequestInitMock(...args),
}));

vi.mock('./oauth/oauthAccount.js', () => ({
  getOauthInfoFromAccount: (...args: unknown[]) => getOauthInfoFromAccountMock(...args),
}));

vi.mock('./oauth/service.js', () => ({
  buildOauthProviderHeaders: (...args: unknown[]) => buildOauthProviderHeadersMock(...args),
}));

describe('probeRuntimeModel', () => {
  const site = {
    id: 1,
    name: 'probe-site',
    url: 'https://probe.example.com',
    platform: 'new-api',
    status: 'active',
  } as any;

  const account = {
    id: 1,
    siteId: 1,
    username: 'probe-user',
    accessToken: '',
    apiToken: 'sk-probe',
    status: 'active',
    extraConfig: null,
  } as any;

  beforeEach(() => {
    vi.resetModules();
    resolveUpstreamEndpointCandidatesMock.mockReset();
    buildUpstreamEndpointRequestMock.mockReset();
    dispatchRuntimeRequestMock.mockReset();
    resolveChannelProxyUrlMock.mockReset();
    withSiteRecordProxyRequestInitMock.mockReset();
    getOauthInfoFromAccountMock.mockReset();
    buildOauthProviderHeadersMock.mockReset();

    getOauthInfoFromAccountMock.mockReturnValue(null);
    buildOauthProviderHeadersMock.mockReturnValue({});
    buildUpstreamEndpointRequestMock.mockReturnValue({
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: { model: 'gpt-5.4' },
      runtime: {
        executor: 'default',
        modelName: 'gpt-5.4',
        stream: false,
      },
    });
    resolveChannelProxyUrlMock.mockReturnValue(null);
    withSiteRecordProxyRequestInitMock.mockImplementation(async (_site: unknown, init: RequestInit) => init);
  });

  it('returns an inconclusive result instead of throwing when endpoint resolution fails', async () => {
    resolveUpstreamEndpointCandidatesMock.mockRejectedValue(new Error('resolution failed'));

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 10,
    });

    expect(result.status).toBe('inconclusive');
    expect(result.reason).toContain('resolution failed');
    expect(result.latencyMs).not.toBeNull();
  });

  it('uses the remaining timeout budget for the runtime request phase', async () => {
    resolveUpstreamEndpointCandidatesMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return ['chat'];
    });
    dispatchRuntimeRequestMock.mockImplementation(async (input: {
      buildInit: (requestUrl: string, request: Record<string, unknown>) => Promise<RequestInit>;
      request: Record<string, unknown>;
      targetUrl?: string;
    }) => {
      const init = await input.buildInit(input.targetUrl || 'https://probe.example.com/v1/chat/completions', input.request);
      const signal = init.signal as AbortSignal | undefined;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 40);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('aborted'));
        }, { once: true });
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const startedAt = Date.now();
    const result = await probeRuntimeModel({
      site,
      account,
      modelName: 'gpt-5.4',
      timeoutMs: 30,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe('inconclusive');
    expect(result.latencyMs).not.toBeNull();
    expect(elapsedMs).toBeLessThan(200);
  });

  it('falls back to accessToken for session accounts when apiToken is empty', async () => {
    resolveUpstreamEndpointCandidatesMock.mockResolvedValue([{
      id: 'chat',
      path: '/v1/chat/completions',
      format: 'openai',
    }]);
    dispatchRuntimeRequestMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
      body: { getReader: () => ({ read: async () => ({ done: true }) }) },
    });
    withSiteRecordProxyRequestInitMock.mockImplementation((_site, init) => init);

    const sessionAccount = {
      ...account,
      apiToken: '',
      accessToken: 'session-cookie-token',
    };

    const { probeRuntimeModel } = await import('./runtimeModelProbe.js');
    const result = await probeRuntimeModel({
      site,
      account: sessionAccount,
      modelName: 'gpt-5.4',
      timeoutMs: 5000,
    });

    expect(result.status).toBe('supported');
    expect(buildUpstreamEndpointRequestMock).toHaveBeenCalled();
    const built = buildUpstreamEndpointRequestMock.mock.calls[0][0];
    expect(built.tokenValue).toBe('session-cookie-token');
  });

  it('labels relay model-channel authorization failures separately from account credentials', async () => {
    const { classifyProbeFailureReason } = await import('./runtimeModelProbe.js');
    const reason = classifyProbeFailureReason(401, '{"error":{"message":"Authorization failed","type":"bad_response_status_code"}}');
    expect(reason).toContain('上游模型渠道鉴权失败');
    expect(reason).toContain('不是 MetAPI 账户凭证失效');
  });

  it('labels relay model-not-found responses as channel unavailable', async () => {
    const { classifyProbeFailureReason } = await import('./runtimeModelProbe.js');
    const reason = classifyProbeFailureReason(404, '{"error":{"message":"Model not found"}}');
    expect(reason).toContain('上游模型渠道不可用');
    expect(reason).toContain('本站其他模型可能仍正常');
  });

});
