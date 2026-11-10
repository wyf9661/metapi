import { describe, expect, it } from 'vitest';
import { buildUpstreamUrl } from './upstreamRequest.js';

describe('buildUpstreamUrl version-suffix dedupe', () => {
  it('strips the /v1 prefix when the base already ends with /v1', () => {
    expect(buildUpstreamUrl('https://relay.example/api/v1', '/v1/chat/completions'))
      .toBe('https://relay.example/api/v1/chat/completions');
  });

  it('strips the /v1 prefix when the base ends with any /vN version segment (docs-pasted bases like /paas/v4)', () => {
    expect(buildUpstreamUrl('https://relay.example/api/coding/paas/v4', '/v1/chat/completions'))
      .toBe('https://relay.example/api/coding/paas/v4/chat/completions');
    expect(buildUpstreamUrl('https://relay.example/api/coding/paas/v4', '/v1/messages'))
      .toBe('https://relay.example/api/coding/paas/v4/messages');
  });

  it('keeps appending /v1 when the base has no version segment', () => {
    expect(buildUpstreamUrl('https://relay.example/api', '/v1/chat/completions'))
      .toBe('https://relay.example/api/v1/chat/completions');
    expect(buildUpstreamUrl('https://relay.example', '/v1/responses'))
      .toBe('https://relay.example/v1/responses');
  });
});
