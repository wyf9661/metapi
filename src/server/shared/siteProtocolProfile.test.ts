import { describe, expect, it } from 'vitest';
import {
  mapUpstreamErrorForClient,
  parseSiteProtocolProfile,
  resolveSiteProtocolProfile,
  serializeSiteProtocolProfile,
  siteProtocolAffinityFactor,
  siteProtocolPrefersResponses,
} from './siteProtocolProfile.js';

describe('siteProtocolProfile', () => {
  it('parses and serializes profile flags', () => {
    const profile = parseSiteProtocolProfile({
      preferResponses: true,
      requireCodexClient: true,
      credentialMode: 'session',
    });
    expect(profile.preferResponses).toBe(true);
    expect(JSON.parse(serializeSiteProtocolProfile(profile)).requireCodexClient).toBe(true);
  });

  it('infers responses preference from Codex custom headers', () => {
    const resolved = resolveSiteProtocolProfile({
      protocolProfile: null,
      customHeaders: JSON.stringify({
        'User-Agent': 'codex_cli_rs/0.39.0',
        originator: 'codex_cli_rs',
      }),
    });
    expect(resolved.preferResponses).toBe(true);
    expect(resolved.requireCodexClient).toBe(true);
    expect(siteProtocolPrefersResponses({
      customHeaders: 'User-Agent: openai-codex/1.0',
    })).toBe(true);
  });

  it('maps codex policy and no-capacity errors for clients', () => {
    const codex = mapUpstreamErrorForClient(403, JSON.stringify({
      error: { code: 'codex_requires_responses_protocol' },
    }));
    expect(codex.code).toBe('codex_requires_responses');
    expect(codex.retryable).toBe(false);

    const capacity = mapUpstreamErrorForClient(503, '无可用账号，请稍后重试');
    expect(capacity.code).toBe('upstream_no_capacity');
    expect(capacity.retryable).toBe(true);
  });

  it('scores protocol affinity without hard demotion', () => {
    expect(siteProtocolAffinityFactor({ protocolProfile: null })).toBe(1);
    expect(siteProtocolAffinityFactor({
      protocolProfile: JSON.stringify({ preferResponses: true, requireCodexClient: false, credentialMode: 'auto' }),
    })).toBeCloseTo(1.1, 5);
    expect(siteProtocolAffinityFactor({
      protocolProfile: JSON.stringify({ preferResponses: true, requireCodexClient: true, credentialMode: 'auto' }),
    })).toBeCloseTo(1.18, 5);
  });
});

  it('maps endpoint pool exhaustion to endpoint_all_down', () => {
    const mapped = mapUpstreamErrorForClient(502, '当前站点的 API 请求地址均不可用');
    expect(mapped.code).toBe('endpoint_all_down');
    expect(mapped.retryable).toBe(true);
  });

