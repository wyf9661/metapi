import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchModelPricingCatalogMock = vi.fn(async (_arg?: unknown): Promise<any> => null);

vi.mock('./modelPricingService.js', () => ({
  fetchModelPricingCatalog: (arg: unknown) => fetchModelPricingCatalogMock(arg),
}));

import { resolveUpstreamEndpointCandidates } from './upstreamEndpointDerivation.js';
import { resetUpstreamEndpointRuntimeState } from './upstreamEndpointRuntimeMemory.js';

const baseContext = {
  site: {
    id: 1,
    url: 'https://upstream.example.com',
    platform: 'new-api',
    apiKey: 'sk-demo',
    protocolProfile: null as string | null,
  },
  account: {
    id: 2,
    accessToken: 'token-demo',
    apiToken: null,
  },
};

describe('upstreamEndpointDerivation', () => {
  beforeEach(() => {
    fetchModelPricingCatalogMock.mockReset();
    fetchModelPricingCatalogMock.mockResolvedValue(null);
    resetUpstreamEndpointRuntimeState();
  });

  it('derives compact requests directly to responses from the service owner', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'responses',
      undefined,
      undefined,
      {
        requestKind: 'responses-compact',
      },
    );

    expect(order).toEqual(['responses']);
  });

  it('derives codex oauth openai requests as responses-first without surface-local reordering', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
      undefined,
      undefined,
      {
        oauthProvider: 'codex',
      },
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
  });

  it('uses chat-first for explicit openai platforms unless responses are marked', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
        },
      },
      'glm-5.2',
      'openai',
    );

    expect(order).toEqual(['chat', 'messages', 'responses']);
  });

  it('keeps antigravity non-gemini compatibility requests on messages-first ordering', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'antigravity',
        },
      },
      'claude-opus-4-6',
      'openai',
      undefined,
      {
        hasNonImageFileInput: true,
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('keeps claude-family file-url requests messages-first for claude upstreams', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'claude',
        },
      },
      'claude-opus-4-6',
      'responses',
      undefined,
      {
        hasNonImageFileInput: true,
      },
      {
        requiresNativeResponsesFileUrl: true,
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('derives claude count_tokens requests as messages-only when the upstream supports messages', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
        },
      },
      'claude-sonnet-4-5-20250929',
      'claude',
      undefined,
      undefined,
      {
        requestKind: 'claude-count-tokens',
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('returns no candidates for claude count_tokens when the upstream does not support messages', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'codex',
          url: 'https://chatgpt.com/backend-api/codex',
        },
      },
      'gpt-5.4',
      'claude',
      undefined,
      undefined,
      {
        requestKind: 'claude-count-tokens',
      },
    );

    expect(order).toEqual([]);
  });

  it('uses chat-first for generic new-api openai requests', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'glm-5.2',
      'openai',
    );
    expect(order).toEqual(['chat', 'messages', 'responses']);
  });

  it('uses messages-first for claude-family models on generic new-api sites', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'claude-opus-4-6',
      'openai',
    );
    // Claude-family still prefers messages first; cascade must recover to chat
    // when messages returns NewAPI "no available channel" (liWAN-class relays).
    expect(order).toEqual(['messages', 'chat', 'responses']);
  });

  it('keeps chat-only families chat-first even when a legacy profile prefers responses', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          protocolProfile: JSON.stringify({
            preferResponses: true,
            requireCodexClient: false,
            credentialMode: 'auto',
          }),
        },
      },
      'glm-5.2',
      'openai',
    );
    // 排序由模型家族决定，站点档案不再参与：glm 属 chat-only 家族
    // （new-api PR #5209），走通用面 chat。
    expect(order).toEqual(['chat', 'messages', 'responses']);
  });

  it('keeps Claude-family models messages-first regardless of legacy Codex-site profiles', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          protocolProfile: JSON.stringify({
            preferResponses: true,
            requireCodexClient: true,
            credentialMode: 'auto',
          }),
        },
      },
      'claude-opus-5',
      'openai',
    );
    expect(order).toEqual(['messages', 'chat', 'responses']);
  });

  it('keeps OpenAI-family models responses-first (the Codex face) with legacy Codex-site profiles', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          protocolProfile: JSON.stringify({
            preferResponses: true,
            requireCodexClient: true,
            credentialMode: 'auto',
          }),
        },
      },
      'gpt-5.6-sol',
      'openai',
    );
    expect(order).toEqual(['responses', 'chat', 'messages']);
  });

  it('lets runtime memory demote responses for OpenAI-family models when the upstream only serves chat', async () => {
    const { recordUpstreamEndpointFailure } = await import('./upstreamEndpointRuntimeMemory.js');
    recordUpstreamEndpointFailure({
      siteId: baseContext.site.id,
      endpoint: 'responses',
      downstreamFormat: 'openai',
      modelName: 'gpt-5.6-sol',
      status: 404,
      errorText: 'endpoint not found',
    });

    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          protocolProfile: JSON.stringify({
            preferResponses: true,
            requireCodexClient: false,
            credentialMode: 'auto',
          }),
          customHeaders: JSON.stringify({
            originator: 'codex_cli_rs',
            'user-agent': 'codex_cli_rs/0.39.0',
          }),
        },
      },
      'gpt-5.6-sol',
      'openai',
    );

    // 家族初始序让 responses 居首，但没有钉死：记忆记录 404 后降权，回落 chat。
    expect(order).toEqual(['chat', 'messages']);
  });

  it('lets runtime memory demote responses for chat-only families', async () => {
    const { recordUpstreamEndpointFailure } = await import('./upstreamEndpointRuntimeMemory.js');
    recordUpstreamEndpointFailure({
      siteId: baseContext.site.id,
      endpoint: 'responses',
      downstreamFormat: 'openai',
      modelName: 'glm-5.2',
      status: 404,
      errorText: 'endpoint not found',
    });

    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          protocolProfile: JSON.stringify({
            preferResponses: true,
            requireCodexClient: false,
            credentialMode: 'auto',
          }),
        },
      },
      'glm-5.2',
      'openai',
    );

    // responses 被记忆挡住后，chat-only 家族落到原生面 chat，而不是被钉回第一位。
    expect(order).toEqual(['chat', 'messages']);
  });

  it('keeps Claude count_tokens messages-only on preferResponses sites', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          protocolProfile: JSON.stringify({
            preferResponses: true,
            requireCodexClient: true,
            credentialMode: 'auto',
          }),
        } as any,
      },
      'claude-opus-4-6',
      'claude',
      undefined,
      undefined,
      { requestKind: 'claude-count-tokens' },
    );

    expect(order).toEqual(['messages']);
  });

  it('keeps OpenAI-family models responses-first with Codex custom headers alone', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          customHeaders: JSON.stringify({
            originator: 'codex_cli_rs',
            'user-agent': 'codex_cli_rs/0.39.0',
          }),
        },
      },
      'gpt-5.6-sol',
      'openai',
    );
    expect(order[0]).toBe('responses');
  });

  it('keeps Claude-family traffic messages-first on Anthropic-compat sites that also prefer responses', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          protocolProfile: JSON.stringify({
            preferResponses: true,
            preferMessages: true,
            requireCodexClient: false,
            credentialMode: 'api_key',
          }),
        },
      },
      'claude-opus-5-5',
      'openai',
    );
    expect(order).toEqual(['messages', 'chat', 'responses']);
  });

  it('keeps OpenAI-family traffic responses-first with legacy Anthropic-compat profiles', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          protocolProfile: JSON.stringify({
            preferResponses: true,
            preferMessages: true,
            requireCodexClient: false,
            credentialMode: 'api_key',
          }),
        },
      },
      'gpt-5.6-sol',
      'openai',
    );
    expect(order).toEqual(['responses', 'chat', 'messages']);
  });
});
