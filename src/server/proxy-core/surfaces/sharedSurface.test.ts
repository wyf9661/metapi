import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY } from '../../services/downstreamPolicyTypes.js';

const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const composeProxyLogMessageMock = vi.fn();
const formatUtcSqlDateTimeMock = vi.fn();
const insertProxyLogMock = vi.fn();
const resolveChannelProxyUrlMock = vi.fn();
const withSiteRecordProxyRequestInitMock = vi.fn();
const dispatchRuntimeRequestMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const isTokenExpiredErrorMock = vi.fn();
const shouldRetryProxyRequestMock = vi.fn();
const recordOauthQuotaResetHintMock = vi.fn();

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../routes/proxy/logPathMeta.js', () => ({
  composeProxyLogMessage: (...args: unknown[]) => composeProxyLogMessageMock(...args),
}));

vi.mock('../../services/localTimeService.js', () => ({
  formatUtcSqlDateTime: (...args: unknown[]) => formatUtcSqlDateTimeMock(...args),
}));

vi.mock('../../services/proxyLogStore.js', () => ({
  insertProxyLog: (...args: unknown[]) => insertProxyLogMock(...args),
}));

vi.mock('../../services/siteProxy.js', () => ({
  resolveChannelProxyUrl: (...args: unknown[]) => resolveChannelProxyUrlMock(...args),
  withSiteRecordProxyRequestInit: (...args: unknown[]) => withSiteRecordProxyRequestInitMock(...args),
}));

vi.mock('../../routes/proxy/runtimeExecutor.js', () => ({
  dispatchRuntimeRequest: (...args: unknown[]) => dispatchRuntimeRequestMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: (...args: unknown[]) => isTokenExpiredErrorMock(...args),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: (...args: unknown[]) => shouldRetryProxyRequestMock(...args),
}));

vi.mock('../../services/oauth/quota.js', () => ({
  recordOauthQuotaResetHint: (...args: unknown[]) => recordOauthQuotaResetHintMock(...args),
}));

describe('selectSurfaceChannelForAttempt', () => {
  beforeEach(() => {
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    composeProxyLogMessageMock.mockReset();
    formatUtcSqlDateTimeMock.mockReset();
    insertProxyLogMock.mockReset();
    resolveChannelProxyUrlMock.mockReset();
    withSiteRecordProxyRequestInitMock.mockReset();
    dispatchRuntimeRequestMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    isTokenExpiredErrorMock.mockReset();
    shouldRetryProxyRequestMock.mockReset();
    recordOauthQuotaResetHintMock.mockReset();
  });

  it('refreshes models and retries selectChannel on the first attempt when no channel is available', async () => {
    const selected = { channel: { id: 11 } };
    selectChannelMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(selected);

    const { selectSurfaceChannelForAttempt } = await import('./sharedSurface.js');
    const result = await selectSurfaceChannelForAttempt({
      requestedModel: 'gpt-5.2',
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
    });

    expect(result).toBe(selected);
    expect(selectChannelMock).toHaveBeenCalledTimes(2);
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(refreshModelsAndRebuildRoutesMock).toHaveBeenCalledTimes(1);
  });

  it('uses selectNextChannel on retry attempts without refreshing models', async () => {
    const selected = { channel: { id: 22 } };
    selectNextChannelMock.mockResolvedValueOnce(selected);

    const { selectSurfaceChannelForAttempt } = await import('./sharedSurface.js');
    const result = await selectSurfaceChannelForAttempt({
      requestedModel: 'gpt-5.2',
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [11],
      retryCount: 1,
    });

    expect(result).toBe(selected);
    expect(selectChannelMock).not.toHaveBeenCalled();
    expect(selectNextChannelMock).toHaveBeenCalledWith(
      'gpt-5.2',
      [11],
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
    );
    expect(refreshModelsAndRebuildRoutesMock).not.toHaveBeenCalled();
  });

  it('writes proxy logs through the shared log formatter and store', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);

    const { writeSurfaceProxyLog } = await import('./sharedSurface.js');
    await writeSurfaceProxyLog({
      warningScope: 'chat',
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33 },
        actualModel: 'upstream-model',
      },
      modelRequested: 'gpt-5.2',
      status: 'failed',
      httpStatus: 502,
      latencyMs: 1200,
      errorMessage: 'upstream failed',
      retryCount: 1,
      downstreamPath: '/v1/chat/completions',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimatedCost: 0.42,
      billingDetails: { source: 'test' },
      upstreamPath: '/v1/responses',
      clientContext: {
        clientKind: 'codex',
        clientAppId: 'app-id',
        clientAppName: 'App',
        clientConfidence: 'high',
        sessionId: 'sess-1',
        traceHint: 'trace-1',
      },
      downstreamApiKeyId: 44,
    });

    expect(composeProxyLogMessageMock).toHaveBeenCalledWith({
      clientKind: 'codex',
      sessionId: 'sess-1',
      traceHint: 'trace-1',
      downstreamPath: '/v1/chat/completions',
      upstreamPath: '/v1/responses',
      errorMessage: 'upstream failed',
    });
    expect(insertProxyLogMock).toHaveBeenCalledWith({
      routeId: 22,
      channelId: 11,
      accountId: 33,
      downstreamApiKeyId: 44,
      modelRequested: 'gpt-5.2',
      modelActual: 'upstream-model',
      status: 'failed',
      httpStatus: 502,
      latencyMs: 1200,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimatedCost: 0.42,
      billingDetails: { source: 'test' },
      clientFamily: 'codex',
      clientAppId: 'app-id',
      clientAppName: 'App',
      clientConfidence: 'high',
      errorMessage: 'normalized error',
      retryCount: 1,
      createdAt: '2026-03-21 22:00:00',
    });
  });

  it('builds runtime dispatch requests with site proxy initialization', async () => {
    const site = { url: 'https://upstream.example.com' };
    const request = {
      endpoint: 'responses',
      path: '/v1/responses',
      headers: { authorization: 'Bearer test' },
      body: { model: 'gpt-5.2', input: 'hello' },
      runtime: { executor: 'default' },
    };
    resolveChannelProxyUrlMock.mockReturnValue('http://proxy.example.com');
    withSiteRecordProxyRequestInitMock.mockImplementation(async (_site, init, proxyUrl) => ({
      ...init,
      proxyUrl,
    }));
    dispatchRuntimeRequestMock.mockResolvedValue('ok');

    const { createSurfaceDispatchRequest } = await import('./sharedSurface.js');
    const dispatchRequest = createSurfaceDispatchRequest({
      site,
      accountExtraConfig: '{"proxyUrl":"http://proxy.example.com"}',
    });
    const result = await dispatchRequest(request, 'https://target.example.com/v1/responses');

    expect(result).toBe('ok');
    expect(resolveChannelProxyUrlMock).toHaveBeenCalledWith(
      site,
      '{"proxyUrl":"http://proxy.example.com"}',
    );
    expect(dispatchRuntimeRequestMock).toHaveBeenCalledTimes(1);
    const dispatchArg = dispatchRuntimeRequestMock.mock.calls[0]?.[0];
    expect(dispatchArg.siteUrl).toBe('https://upstream.example.com');
    expect(dispatchArg.targetUrl).toBe('https://target.example.com/v1/responses');
    expect(dispatchArg.request).toBe(request);
    return dispatchArg.buildInit('https://target.example.com/v1/responses', {
      headers: { authorization: 'Bearer test' },
      body: { model: 'gpt-5.2', input: 'hello' },
    }).then((init: Record<string, unknown>) => {
      expect(withSiteRecordProxyRequestInitMock).toHaveBeenCalledWith(site, {
        method: 'POST',
        headers: { authorization: 'Bearer test' },
        body: JSON.stringify({ model: 'gpt-5.2', input: 'hello' }),
      }, 'http://proxy.example.com');
      expect(init).toEqual({
        method: 'POST',
        headers: { authorization: 'Bearer test' },
        body: JSON.stringify({ model: 'gpt-5.2', input: 'hello' }),
        proxyUrl: 'http://proxy.example.com',
      });
    });
  });

  it('retries retryable upstream HTTP failures through the shared failure toolkit', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);
    shouldRetryProxyRequestMock.mockReturnValue(true);
    isTokenExpiredErrorMock.mockReturnValue(false);
    recordOauthQuotaResetHintMock.mockResolvedValue(null);

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'chat',
      downstreamPath: '/v1/chat/completions',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: 44,
    });

    const result = await toolkit.handleUpstreamFailure({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      status: 429,
      errText: 'quota exceeded',
      rawErrText: '{"error":"quota exceeded"}',
      latencyMs: 1200,
      retryCount: 0,
    });

    expect(result).toEqual({ action: 'retry' });
    expect(recordFailureMock).toHaveBeenCalledWith(11, {
      status: 429,
      errorText: '{"error":"quota exceeded"}',
      modelName: 'upstream-model',
    });
    expect(recordOauthQuotaResetHintMock).toHaveBeenCalledWith({
      accountId: 33,
      statusCode: 429,
      errorText: '{"error":"quota exceeded"}',
    });
    expect(reportProxyAllFailedMock).not.toHaveBeenCalled();
    expect(insertProxyLogMock).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 11,
      accountId: 33,
      downstreamApiKeyId: 44,
      modelRequested: 'gpt-5.2',
      modelActual: 'upstream-model',
      status: 'failed',
      httpStatus: 429,
      latencyMs: 1200,
      errorMessage: 'normalized error',
      retryCount: 0,
    }));
  });

  it('returns a terminal upstream error response and reports token expiration when retries stop', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);
    shouldRetryProxyRequestMock.mockReturnValue(false);
    isTokenExpiredErrorMock.mockReturnValue(true);
    recordOauthQuotaResetHintMock.mockResolvedValue(null);

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'responses',
      downstreamPath: '/v1/responses',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: null,
    });

    const result = await toolkit.handleUpstreamFailure({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      status: 401,
      errText: 'expired token',
      rawErrText: 'expired token',
      latencyMs: 900,
      retryCount: 2,
    });

    expect(result).toEqual({
      action: 'respond',
      status: 401,
      payload: {
        error: {
          message: 'expired token',
          type: 'upstream_error',
        },
      },
    });
    expect(reportTokenExpiredMock).toHaveBeenCalledWith({
      accountId: 33,
      username: 'oauth-user',
      siteName: 'Codex OAuth',
      detail: 'HTTP 401',
    });
    expect(reportProxyAllFailedMock).toHaveBeenCalledWith({
      model: 'gpt-5.2',
      reason: 'upstream returned HTTP 401',
    });
  });

  it('handles detected proxy failures through the shared failure toolkit', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);
    shouldRetryProxyRequestMock.mockReturnValue(false);

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'chat',
      downstreamPath: '/v1/chat/completions',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: null,
    });

    const result = await toolkit.handleDetectedFailure({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      failure: {
        status: 500,
        reason: 'upstream failure',
      },
      latencyMs: 700,
      retryCount: 2,
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      upstreamPath: '/v1/responses',
    });

    expect(result).toEqual({
      action: 'respond',
      status: 500,
      payload: {
        error: {
          message: 'upstream failure',
          type: 'upstream_error',
        },
      },
    });
    expect(recordFailureMock).toHaveBeenCalledWith(11, {
      status: 500,
      errorText: 'upstream failure',
      modelName: 'upstream-model',
    });
    expect(reportProxyAllFailedMock).toHaveBeenCalledWith({
      model: 'gpt-5.2',
      reason: 'upstream failure',
    });
    expect(recordOauthQuotaResetHintMock).not.toHaveBeenCalled();
  });

  it('returns a terminal 502 for exhausted network failures through the shared failure toolkit', async () => {
    composeProxyLogMessageMock.mockReturnValue('normalized error');
    formatUtcSqlDateTimeMock.mockReturnValue('2026-03-21 22:00:00');
    insertProxyLogMock.mockResolvedValue(undefined);

    const { createSurfaceFailureToolkit } = await import('./sharedSurface.js');
    const toolkit = createSurfaceFailureToolkit({
      warningScope: 'responses',
      downstreamPath: '/v1/responses',
      maxRetries: 2,
      clientContext: null,
      downstreamApiKeyId: null,
    });

    const result = await toolkit.handleExecutionError({
      selected: {
        channel: { id: 11, routeId: 22 },
        account: { id: 33, username: 'oauth-user' },
        site: { name: 'Codex OAuth' },
        actualModel: 'upstream-model',
      },
      requestedModel: 'gpt-5.2',
      modelName: 'upstream-model',
      errorMessage: 'socket hang up',
      latencyMs: 650,
      retryCount: 2,
    });

    expect(result).toEqual({
      action: 'respond',
      status: 502,
      payload: {
        error: {
          message: 'Upstream error: socket hang up',
          type: 'upstream_error',
        },
      },
    });
    expect(recordFailureMock).toHaveBeenCalledWith(11, {
      errorText: 'socket hang up',
      modelName: 'upstream-model',
    });
    expect(reportProxyAllFailedMock).toHaveBeenCalledWith({
      model: 'gpt-5.2',
      reason: 'socket hang up',
    });
  });
});
