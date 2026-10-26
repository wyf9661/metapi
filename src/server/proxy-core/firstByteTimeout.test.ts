import { describe, expect, it } from 'vitest';
import { Response as UndiciResponse } from 'undici';

import {
  fetchWithObservedFirstByte,
  getObservedResponseMeta,
  isObservedFirstByteTimeoutResponse,
  parseLocalFirstByteTimeoutBudgetMs,
} from './firstByteTimeout.js';

function buildDelayedResponse(bodyText: string, delayMs: number, status = 200): UndiciResponse {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(encoder.encode(bodyText));
        controller.close();
      }, delayMs);
    },
  });
  return new UndiciResponse(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

describe('fetchWithObservedFirstByte', () => {
  it('replays the first chunk and records first-byte latency when upstream responds in time', async () => {
    const response = await fetchWithObservedFirstByte(
      async () => buildDelayedResponse('hello world', 5),
      {
        firstByteTimeoutMs: 100,
        startedAtMs: Date.now(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello world');

    const meta = getObservedResponseMeta(response);
    expect(meta?.timedOutBeforeFirstByte).toBe(false);
    expect(meta?.firstByteLatencyMs).not.toBeNull();
    expect((meta?.firstByteLatencyMs || 0)).toBeGreaterThanOrEqual(0);
    expect((meta?.firstByteLatencyMs || 0)).toBeLessThan(100);
  });

  it('returns a synthetic timeout response when upstream sends no first byte before the deadline', async () => {
    const response = await fetchWithObservedFirstByte(
      async () => buildDelayedResponse('too late', 80),
      {
        firstByteTimeoutMs: 10,
        startedAtMs: Date.now(),
      },
    );

    expect(response.status).toBe(408);
    expect(await response.text()).toContain('first byte timeout');
    expect(isObservedFirstByteTimeoutResponse(response)).toBe(true);

    const meta = getObservedResponseMeta(response);
    expect(meta?.timedOutBeforeFirstByte).toBe(true);
    expect(meta?.firstByteLatencyMs).toBeNull();
  });
});

describe('parseLocalFirstByteTimeoutBudgetMs', () => {
  it('reads our own sentinel as a censored observation', () => {
    // Shipped failure text when this instance expired its own window.
    const message = '[trace:r_ed87edd2ee79] [downstream:/v1/chat/completions] '
      + '[code:upstream_error] [site:MetapiMesh] [status:408] first byte timeout (8s)';
    expect(parseLocalFirstByteTimeoutBudgetMs(message)).toBe(8_000);
  });

  it('ignores a peer that returned this same sentinel as its 408 body', () => {
    // Production 2026-10-26: a cascade peer running the same code pinches the
    // request at its own 8s wall and returns the text as an HTTP 408 body. That
    // is the upstream's censor point, not ours: charging it to our curve both
    // faked a timeout trigger and recorded the wrong budget.
    const message = '[trace:r_0118e6c1bbae] [downstream:/v1/chat/completions] '
      + '[upstream:/v1/chat/completions] [code:upstream_error] [site:MetapiMesh] '
      + '[status:408] Upstream returned HTTP 408: first byte timeout (8s)';
    expect(parseLocalFirstByteTimeoutBudgetMs(message)).toBeNull();
  });

  it('returns null for messages without a local timeout sentinel', () => {
    expect(parseLocalFirstByteTimeoutBudgetMs('Upstream returned HTTP 502: bad gateway')).toBeNull();
    expect(parseLocalFirstByteTimeoutBudgetMs('Upstream returned HTTP 408: {')).toBeNull();
    expect(parseLocalFirstByteTimeoutBudgetMs('')).toBeNull();
    expect(parseLocalFirstByteTimeoutBudgetMs(null)).toBeNull();
    expect(parseLocalFirstByteTimeoutBudgetMs(undefined)).toBeNull();
  });
});
