import { useEffect, useRef } from 'react';
import { fetchAuthenticatedResponse } from '../api.js';

/**
 * Subscribe to the server-side SSE stream for proxy-log events.
 *
 * When `enabled`, opens an authenticated fetch stream to
 * `/api/stats/proxy-logs/stream`. Native EventSource cannot send the
 * admin Bearer header, so using EventSource here would cause a 401 loop.
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
 * - Watchdog: if no frame (including heartbeat) is received within
 *   `WDOG_MS`, the connection is assumed to be buffered by an
 *   intermediate proxy (e.g. Cloudflare quick tunnels). In that case
 *   SSE is abandoned and `onEvent` is invoked on a polling interval
 *   (`FALLBACK_MS`) instead, so auto-refresh keeps working behind
 *   proxies that cannot stream SSE.
 */

const WDOG_MS = 15_000; // Must exceed typical proxy flush delay but be short
                     // enough to degrade gracefully if SSE is buffered.
const FALLBACK_MS = 5_000; // Polling interval when SSE is unavailable.

export function useProxyLogSSE(
  onEvent: () => void,
  enabled: boolean,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;

    let connectionController: AbortController | null = null;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let connecting = false;
    let reconnectDelay = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let sseUsable = true; // Set to false after a watchdog timeout.

    const isVisible = () =>
      typeof document === 'undefined' ||
      document.visibilityState === 'visible';

    const clearWatchdog = () => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    };

    const startFallback = () => {
      if (fallbackTimer || disposed) return;
      sseUsable = false;
      fallbackTimer = setInterval(() => {
        if (!disposed && isVisible()) onEventRef.current();
      }, FALLBACK_MS);
    };

    const stopFallback = () => {
      if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    };

    const scheduleReconnect = () => {
      if (disposed || !isVisible() || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
    };

    const connect = async () => {
      if (disposed || !isVisible() || connecting || connectionController) return;
      if (!sseUsable) return; // Already fell back to polling.
      connecting = true;
      const controller = new AbortController();
      connectionController = controller;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let removeAbortListener = () => {};
      try {
        const response = await fetchAuthenticatedResponse(
          '/api/stats/proxy-logs/stream',
          {
            method: 'POST',
            timeoutMs: 0,
            signal: controller.signal,
            headers: { Accept: 'text/event-stream' },
          },
        );
        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: HTTP ${response.status}`);
        }

        reconnectDelay = 1000;
        reader = response.body.getReader();
        const currentReader = reader;
        activeReader = currentReader;
        const abortHandler = () => {
          void currentReader.cancel().catch(() => undefined);
        };
        controller.signal.addEventListener('abort', abortHandler, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener('abort', abortHandler);
        const decoder = new TextDecoder();
        let buffer = '';
        // Arm watchdog: if no frame arrives within WDOG_MS, assume the
        // connection is buffered by a proxy and fall back to polling.
        const armWatchdog = () => {
          clearWatchdog();
          watchdog = setTimeout(() => {
            // No data within the window — SSE is not usable here.
            void currentReader.cancel().catch(() => undefined);
            controller.abort();
            startFallback();
          }, WDOG_MS);
        };
        armWatchdog();
        while (!disposed && !controller.signal.aborted) {
          const { value, done } = await currentReader.read();
          if (done) break;
          clearWatchdog(); // Got data, disarm watchdog for this frame.
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (data) onEventRef.current();
          }
          armWatchdog(); // Re-arm for the next frame window.
        }
        try { await currentReader.cancel(); } catch { /* already closed */ }
        if (!disposed && !controller.signal.aborted) scheduleReconnect();
      } catch (error: any) {
        if (!disposed && !controller.signal.aborted && error?.message !== 'Session expired') {
          scheduleReconnect();
        }
      } finally {
        removeAbortListener();
        clearWatchdog();
        if (reader && activeReader === reader) activeReader = null;
        if (connectionController === controller) connectionController = null;
        if (connectionController === null || connectionController === controller) {
          connecting = false;
        }
      }
    };

    const handleVisibilityChange = () => {
      if (isVisible()) {
        if (!sseUsable) return; // Still in fallback mode; timer keeps running.
        if (!connectionController && !connecting) void connect();
      } else {
        connectionController?.abort();
        void activeReader?.cancel().catch(() => undefined);
        connectionController = null;
        connecting = false;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      }
    };

    if (isVisible()) void connect();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      disposed = true;
      clearWatchdog();
      stopFallback();
      connectionController?.abort();
      void activeReader?.cancel().catch(() => undefined);
      connectionController = null;
      connecting = false;
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
