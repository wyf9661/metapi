import { describe, expect, it } from 'vitest';

import { parseProxyLogMetadata } from './proxyLogMeta.js';

describe('proxyLogMeta', () => {
  it('parses all supported proxy log prefixes', () => {
    expect(parseProxyLogMetadata(
      '[client:codex] [session:turn-1] [trace:req-abc] [downstream:/v1/responses] [upstream:/responses] [usage:self-log] [code:endpoint_all_down] boom',
    )).toEqual({
      clientKind: 'codex',
      sessionId: 'turn-1',
      traceId: 'req-abc',
      downstreamPath: '/v1/responses',
      upstreamPath: '/responses',
      usageSource: 'self-log',
      errorCode: 'endpoint_all_down',
      messageText: 'boom',
    });
  });

  it('keeps plain message text when no metadata prefixes exist', () => {
    expect(parseProxyLogMetadata('network timeout')).toEqual({
      clientKind: null,
      sessionId: null,
      traceId: null,
      downstreamPath: null,
      upstreamPath: null,
      usageSource: null,
      errorCode: null,
      messageText: 'network timeout',
    });
  });

  it('handles mixed-case, partial, reordered, and empty metadata safely', () => {
    expect(parseProxyLogMetadata('[CLIENT:codex] [SESSION:turn-1] [TRACE:req-1] boom')).toEqual({
      clientKind: 'codex',
      sessionId: 'turn-1',
      traceId: 'req-1',
      downstreamPath: null,
      upstreamPath: null,
      usageSource: null,
      errorCode: null,
      messageText: 'boom',
    });

    expect(parseProxyLogMetadata('[client:codex] boom')).toEqual({
      clientKind: 'codex',
      sessionId: null,
      traceId: null,
      downstreamPath: null,
      upstreamPath: null,
      usageSource: null,
      errorCode: null,
      messageText: 'boom',
    });

    expect(parseProxyLogMetadata('[upstream:/x] [client:codex] [session:1] [trace:t9] msg')).toEqual({
      clientKind: 'codex',
      sessionId: '1',
      traceId: 't9',
      downstreamPath: null,
      upstreamPath: '/x',
      usageSource: null,
      errorCode: null,
      messageText: 'msg',
    });

    expect(parseProxyLogMetadata('')).toEqual({
      clientKind: null,
      sessionId: null,
      traceId: null,
      downstreamPath: null,
      upstreamPath: null,
      usageSource: null,
      errorCode: null,
      messageText: '',
    });
  });
});
