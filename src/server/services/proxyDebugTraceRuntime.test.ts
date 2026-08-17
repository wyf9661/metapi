import { describe, expect, it } from 'vitest';
import {
  appendRouteDecisionTraceEvent,
  reserveSurfaceProxyDebugAttemptBase,
} from './proxyDebugTraceRuntime.js';

describe('reserveSurfaceProxyDebugAttemptBase', () => {
  it('allocates monotonic attempt bases on the same trace session', () => {
    const session = {
      traceId: 801,
      options: {
        enabled: true,
        captureHeaders: true,
        captureBodies: true,
        captureStreamChunks: false,
        targetSessionId: '',
        targetClientKind: '',
        targetModel: '',
        retentionHours: 12,
        maxBodyBytes: 131072,
      },
    };

    expect(reserveSurfaceProxyDebugAttemptBase(session, 3)).toBe(0);
    expect(reserveSurfaceProxyDebugAttemptBase(session, 2)).toBe(3);
    expect(reserveSurfaceProxyDebugAttemptBase(session, 4)).toBe(5);
  });

  it('reserves at least one slot for empty or invalid spans', () => {
    const session = {
      traceId: 802,
      options: {
        enabled: true,
        captureHeaders: true,
        captureBodies: true,
        captureStreamChunks: false,
        targetSessionId: '',
        targetClientKind: '',
        targetModel: '',
        retentionHours: 12,
        maxBodyBytes: 131072,
      },
    };

    expect(reserveSurfaceProxyDebugAttemptBase(session, 0)).toBe(0);
    expect(reserveSurfaceProxyDebugAttemptBase(session, Number.NaN)).toBe(1);
  });
});

describe('route decision trace events', () => {
  it('appends ordered immutable snapshots to a trace session', () => {
    const session = {
      traceId: 803,
      options: {
        enabled: true,
        captureHeaders: false,
        captureBodies: false,
        captureStreamChunks: false,
        targetSessionId: '',
        targetClientKind: '',
        targetModel: '',
        retentionHours: 12,
        maxBodyBytes: 131072,
      },
    };

    const first = appendRouteDecisionTraceEvent(session, 'selection', { selectedChannelId: 7 });
    const second = appendRouteDecisionTraceEvent(session, 'endpoint_attempt', {
      attemptIndex: 0,
      responseStatus: 503,
    });

    expect(first).toHaveLength(1);
    expect(second.map((event) => ({
      sequence: event.sequence,
      stage: event.stage,
      details: event.details,
    }))).toEqual([
      { sequence: 0, stage: 'selection', details: { selectedChannelId: 7 } },
      { sequence: 1, stage: 'endpoint_attempt', details: { attemptIndex: 0, responseStatus: 503 } },
    ]);
    expect(first).toHaveLength(1);
  });
});
