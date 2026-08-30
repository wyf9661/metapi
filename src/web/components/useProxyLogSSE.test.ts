import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';

const { fetchAuthenticatedResponse } = vi.hoisted(() => ({
  fetchAuthenticatedResponse: vi.fn(),
}));

vi.mock('../api.js', () => ({
  fetchAuthenticatedResponse,
}));

import { useProxyLogSSE } from './useProxyLogSSE.js';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

function createStream() {
  let resolveRead: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
  const reader = {
    read: vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
      resolveRead = resolve;
    })),
    cancel: vi.fn(async () => undefined),
  };
  return {
    body: { getReader: () => reader } as unknown as ReadableStream<Uint8Array>,
    reader,
    emit(text: string) {
      resolveRead?.({
        done: false,
        value: new TextEncoder().encode(text),
      });
      resolveRead = undefined;
    },
    end() {
      resolveRead?.({ done: true, value: undefined });
      resolveRead = undefined;
    },
  };
}

function Harness({ onEvent, enabled = true }: { onEvent: () => void; enabled?: boolean }) {
  useProxyLogSSE(onEvent, enabled);
  return null;
}

describe('useProxyLogSSE', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
    fetchAuthenticatedResponse.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('uses authenticated fetch and forwards data events', async () => {
    const stream = createStream();
    fetchAuthenticatedResponse.mockResolvedValue({ ok: true, status: 200, body: stream.body });
    const onEvent = vi.fn();
    let root: ReturnType<typeof create> | undefined;

    await act(async () => {
      root = create(createElement(Harness, { onEvent }));
      await Promise.resolve();
    });

    expect(fetchAuthenticatedResponse).toHaveBeenCalledWith(
      '/api/stats/proxy-logs/stream',
      expect.objectContaining({
        method: 'POST',
        timeoutMs: 0,
        headers: { Accept: 'text/event-stream' },
      }),
    );
    const signal = fetchAuthenticatedResponse.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      stream.emit(': keepalive\n\ndata: {"id":1}\n\n');
      await Promise.resolve();
    });
    expect(onEvent).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    expect(signal.aborted).toBe(true);
    expect(stream.reader.cancel).toHaveBeenCalled();
  });

  it('aborts the stream while hidden and reconnects when visible', async () => {
    const first = createStream();
    const second = createStream();
    fetchAuthenticatedResponse
      .mockResolvedValueOnce({ ok: true, status: 200, body: first.body })
      .mockResolvedValueOnce({ ok: true, status: 200, body: second.body });
    let root: ReturnType<typeof create> | undefined;

    await act(async () => {
      root = create(createElement(Harness, { onEvent: vi.fn() }));
      await Promise.resolve();
    });
    const firstSignal = fetchAuthenticatedResponse.mock.calls[0]?.[1]?.signal as AbortSignal;

    await act(async () => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(firstSignal.aborted).toBe(true);

    await act(async () => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchAuthenticatedResponse).toHaveBeenCalledTimes(2);
    root?.unmount();
  });

  it('falls back to polling when SSE is buffered (watchdog timeout)', async () => {
    // Simulate a proxy that accepts the connection but never sends any data.
    const stream = createStream();
    fetchAuthenticatedResponse.mockResolvedValue({ ok: true, status: 200, body: stream.body });
    const onEvent = vi.fn();
    let root: ReturnType<typeof create> | undefined;

    await act(async () => {
      root = create(createElement(Harness, { onEvent }));
      await Promise.resolve();
    });

    // No data emitted — advance past the watchdog window (15s).
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });

    // SSE connection should have been aborted.
    const signal = fetchAuthenticatedResponse.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(true);

    // Should NOT attempt to reconnect via SSE.
    expect(fetchAuthenticatedResponse).toHaveBeenCalledTimes(1);

    // Fallback polling should fire at FALLBACK_MS (5s) intervals.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(onEvent).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(onEvent).toHaveBeenCalledTimes(2);

    root?.unmount();
  });

  it('does not fall back when heartbeat arrives within watchdog window', async () => {
    const stream = createStream();
    fetchAuthenticatedResponse.mockResolvedValue({ ok: true, status: 200, body: stream.body });
    const onEvent = vi.fn();
    let root: ReturnType<typeof create> | undefined;

    await act(async () => {
      root = create(createElement(Harness, { onEvent }));
      await Promise.resolve();
    });

    // Emit a heartbeat at 14s (just before the 15s watchdog).
    await act(async () => {
      vi.advanceTimersByTime(14_000);
      stream.emit(': keepalive\n\n');
      await Promise.resolve();
    });

    // Advance past the original watchdog window — should have been re-armed.
    await act(async () => {
      vi.advanceTimersByTime(14_000);
      stream.emit(': keepalive\n\n');
      await Promise.resolve();
    });

    // No fallback polling should have started.
    expect(onEvent).toHaveBeenCalledTimes(0);
    // SSE should still be the only connection attempt.
    expect(fetchAuthenticatedResponse).toHaveBeenCalledTimes(1);

    root?.unmount();
  });
});