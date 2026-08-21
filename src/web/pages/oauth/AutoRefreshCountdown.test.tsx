import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { createElement } from 'react';
import AutoRefreshCountdown from './AutoRefreshCountdown.js';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

function collectText(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap((instance) => instance.children)
    .filter((child): child is string => typeof child === 'string')
    .join('');
}

describe('AutoRefreshCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders nothing when auto-refresh is disabled and never ticks', async () => {
    const onRefresh = vi.fn();
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(
        createElement(AutoRefreshCountdown, { intervalSeconds: 0, onRefresh }),
      );
    });
    expect(root?.toJSON()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(0);
    await act(async () => {
      root?.unmount();
    });
  });

  it('counts down each second and fires onRefresh at zero, then restarts', async () => {
    const onRefresh = vi.fn();
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(
        createElement(AutoRefreshCountdown, { intervalSeconds: 3, onRefresh }),
      );
    });
    expect(collectText(root!.root)).toContain('3');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(collectText(root!.root)).toContain('2');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // Third tick hits the boundary: refresh fires and the counter resets.
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(collectText(root!.root)).toContain('3');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      root?.unmount();
    });
  });

  it('pauses while the tab is hidden and resets the countdown when visible again', async () => {
    const onRefresh = vi.fn();
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(
        createElement(AutoRefreshCountdown, { intervalSeconds: 3, onRefresh }),
      );
    });
    await act(async () => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10000);
    });
    // Hidden: no refresh calls at all.
    expect(onRefresh).toHaveBeenCalledTimes(0);
    await act(async () => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(collectText(root!.root)).toContain('3');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      root?.unmount();
    });
  });

  it('stops ticking after unmount', async () => {
    const onRefresh = vi.fn();
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(
        createElement(AutoRefreshCountdown, { intervalSeconds: 1, onRefresh }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      root?.unmount();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
