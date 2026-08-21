import { useEffect, useRef } from 'react';

/**
 * Runs `callback` on a fixed interval, but only while the tab is visible.
 *
 * Three guarantees that a bare setInterval poll does not give you:
 * - Reentrancy guard: a tick is skipped while the previous invocation is still
 *   in flight, so slow endpoints never stack overlapping requests.
 * - Visibility pausing: the timer stops while the document is hidden and fires
 *   one immediate refresh when the tab becomes visible again, so a backgrounded
 *   tab does not keep hammering the server.
 * - Unmount safety: the timer and the visibilitychange listener are always torn
 *   down on cleanup.
 *
 * The callback is read through a ref, so changing `callback` on every render
 * (e.g. a useCallback with many deps) does NOT restart the interval — only
 * `enabled` and `intervalMs` do.
 */
export function useVisiblePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;
    let disposed = false;

    const isVisible = () =>
      typeof document === 'undefined' ||
      document.visibilityState === 'visible';

    const tick = async () => {
      if (disposed || inFlight || !isVisible()) return;
      inFlight = true;
      try {
        await callbackRef.current();
      } finally {
        inFlight = false;
      }
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    };

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const handleVisibilityChange = () => {
      if (isVisible()) {
        void tick();
        start();
      } else {
        stop();
      }
    };

    if (isVisible()) start();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      disposed = true;
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener(
          'visibilitychange',
          handleVisibilityChange,
        );
      }
    };
  }, [enabled, intervalMs]);
}
