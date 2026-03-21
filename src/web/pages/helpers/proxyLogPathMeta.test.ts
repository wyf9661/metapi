import { describe, expect, it } from 'vitest';
import { parseProxyLogPathMeta } from './proxyLogPathMeta.js';

describe('parseProxyLogPathMeta', () => {
  it('parses downstream and upstream paths from prefixed message', () => {
    const parsed = parseProxyLogPathMeta('[downstream:/v1/responses] [upstream:/v1/chat/completions] {"error":"x"}');
    expect(parsed.downstreamPath).toBe('/v1/responses');
    expect(parsed.upstreamPath).toBe('/v1/chat/completions');
    expect(parsed.errorMessage).toBe('{"error":"x"}');
  });

  it('supports historical upstream-only logs', () => {
    const parsed = parseProxyLogPathMeta('[upstream:/v1/messages] messages is required');
    expect(parsed.downstreamPath).toBe(null);
    expect(parsed.upstreamPath).toBe('/v1/messages');
    expect(parsed.errorMessage).toBe('messages is required');
  });

  it('strips legacy client and session prefixes while keeping them available for display', () => {
    const parsed = parseProxyLogPathMeta('[client:codex] [session:turn-123] [downstream:/v1/responses] boom');
    expect(parsed.clientFamily).toBe('codex');
    expect(parsed.sessionId).toBe('turn-123');
    expect(parsed.downstreamPath).toBe('/v1/responses');
    expect(parsed.errorMessage).toBe('boom');
  });

  it('keeps plain message when no metadata exists', () => {
    const parsed = parseProxyLogPathMeta('network timeout');
    expect(parsed.downstreamPath).toBe(null);
    expect(parsed.upstreamPath).toBe(null);
    expect(parsed.errorMessage).toBe('network timeout');
  });
});
