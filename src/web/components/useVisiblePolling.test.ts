import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import { useVisiblePolling } from './useVisiblePolling.js';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

function Harness({
  cb,
  intervalMs = 1000,
  enabled = true,
}: {
  cb: () => void | Promise<void>;
  intervalMs?: number;
  enabled?: boolean;
}) {
  useVisiblePolling(cb, intervalMs, enabled);
  return null;
}

describe('useVisiblePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('polls on the interval while the tab is visible', async () => {
    const cb = vi.fn();
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(Harness, { cb, intervalMs: 1000 }));
    });
    expect(cb).toHaveBeenCalledTimes(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(cb).toHaveBeenCalledTimes(3);
    await act(async () => {
      root?.unmount();
    });
  });

  it('skips a tick while the previous invocation is still in flight', async () => {
    let resolve: (() => void) | undefined;
    const cb = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(Harness, { cb, intervalMs: 1000 }));
    });
    // First tick starts and stays pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    // Two more interval boundaries elapse while the first call is unresolved —
    // no reentrant calls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    // Resolve; the next boundary is allowed to fire again.
    await act(async () => {
      resolve?.();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(cb).toHaveBeenCalledTimes(2);
    await act(async () => {
      root?.unmount();
    });
  });

  it('does not poll while the tab is hidden and refreshes immediately on becoming visible', async () => {
    setVisibility('hidden');
    const cb = vi.fn();
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(Harness, { cb, intervalMs: 1000 }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // Hidden the whole time: never polled.
    expect(cb).toHaveBeenCalledTimes(0);
    // Becoming visible triggers one immediate refresh.
    await act(async () => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(cb).toHaveBeenCalledTimes(1);
    await act(async () => {
      root?.unmount();
    });
  });

  it('stops polling after unmount', async () => {
    const cb = vi.fn();
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(Harness, { cb, intervalMs: 1000 }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    await act(async () => {
      root?.unmount();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a timer when disabled', async () => {
    const cb = vi.fn();
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(
        createElement(Harness, { cb, intervalMs: 1000, enabled: false }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(cb).toHaveBeenCalledTimes(0);
    await act(async () => {
      root?.unmount();
    });
  });
});
