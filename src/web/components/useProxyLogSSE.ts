import { useEffect, useRef } from 'react';

/**
 * Subscribe to the server-side SSE stream for proxy-log events.
 *
 * When `enabled`, opens an EventSource to `/api/stats/proxy-logs/stream`.
 * On each `data` event, calls `onEvent` with the parsed payload so the
 * component can decide whether to reload (e.g. only refresh if filters
 * match, or always reload since the server already filters).
 *
 * Guarantees:
 * - Auto-reconnect with exponential backoff (1s → 2s → 4s → max 10s)
 * - Pauses (closes the connection) while the tab is hidden
 * - Cleans up on unmount
 * - `onEvent` is read through a ref so changing it on every render does NOT
 *   restart the connection
 */
export function useProxyLogSSE(
  onEvent: () => void,
  enabled: boolean,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;

    let es: EventSource | null = null;
    let reconnectDelay = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const isVisible = () =>
      typeof document === 'undefined' ||
      document.visibilityState === 'visible';

    const connect = () => {
      if (disposed || !isVisible()) return;

      es = new EventSource('/api/stats/proxy-logs/stream');

      es.onmessage = () => {
        // Any event means new proxy log(s) — trigger reload
        onEventRef.current();
      };

      es.onerror = () => {
        es?.close();
        es = null;
        if (disposed) return;

        // Exponential backoff, capped at 10s
        reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, reconnectDelay);
      };

      // Reset backoff on successful connection (onopen fires after handshake)
      es.onopen = () => {
        reconnectDelay = 1000;
      };
    };

    const handleVisibilityChange = () => {
      if (isVisible()) {
        if (!es) connect();
      } else {
        es?.close();
        es = null;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      }
    };

    if (isVisible()) connect();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      disposed = true;
      es?.close();
      es = null;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [enabled]);
}
