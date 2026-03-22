import { describe, expect, it } from 'vitest';

import { parseProxyLogMetadata } from './proxyLogMeta.js';

describe('proxyLogMeta', () => {
  it('parses all supported proxy log prefixes', () => {
    expect(parseProxyLogMetadata(
      '[client:codex] [session:turn-1] [downstream:/v1/responses] [upstream:/responses] boom',
    )).toEqual({
      clientKind: 'codex',
      sessionId: 'turn-1',
      downstreamPath: '/v1/responses',
      upstreamPath: '/responses',
      messageText: 'boom',
    });
  });

  it('keeps plain message text when no metadata prefixes exist', () => {
    expect(parseProxyLogMetadata('network timeout')).toEqual({
      clientKind: null,
      sessionId: null,
      downstreamPath: null,
      upstreamPath: null,
      messageText: 'network timeout',
    });
  });
});
