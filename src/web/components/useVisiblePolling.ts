import { useEffect, useRef } from 'react';

/**
 * Runs `callback` on a fixed interval, but only while the tab is visible.
 *
 * Beyond a bare setInterval: ticks are skipped while the previous call is still
 * in flight, the timer stops while the document is hidden and fires one refresh
 * when it returns, and everything is torn down on unmount. Playback is keyed on
 * `enabled` / `intervalMs` alone — `callback` is read through a ref so a new
 * identity does not restart the interval.
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
