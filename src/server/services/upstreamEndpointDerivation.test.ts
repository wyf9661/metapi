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
    apiKey: null,
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

  it('keeps explicit openai platforms on responses-first ordering even for claude-family models', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
        },
      },
      'claude-opus-4-6',
      'openai',
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
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

  it('uses responses-first only when site explicitly prefers responses (Codex compat)', async () => {
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
    expect(order).toEqual(['responses', 'messages', 'chat']);
  });

  it('keeps preferResponses sites responses-first even when runtime memory prefers chat', async () => {
    const { recordUpstreamEndpointSuccess } = await import('./upstreamEndpointRuntimeMemory.js');
    recordUpstreamEndpointSuccess({
      siteId: baseContext.site.id,
      endpoint: 'chat',
      downstreamFormat: 'openai',
      modelName: 'gpt-5.6-sol',
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

    expect(order[0]).toBe('responses');
    expect(order).toContain('chat');
  });

  it('infers preferResponses from Codex custom headers alone', async () => {
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
});
