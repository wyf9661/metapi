import { useEffect, useRef, useState } from 'react';

/**
 * Auto-refresh countdown label with its own tick state.
 *
 * The countdown used to live in OAuthManagement's top-level state, so a 1s
 * setInterval re-rendered the whole 2200-line page (large connection tables and
 * toolbars) once per second the entire time auto-refresh was enabled. Owning the
 * tick here confines the per-second re-render to this label.
 *
 * The timer also pauses while the tab is hidden, so a backgrounded page stops
 * refreshing connections; the countdown restarts from the full interval when the
 * tab becomes visible again.
 */
export default function AutoRefreshCountdown({
  intervalSeconds,
  onRefresh,
}: {
  intervalSeconds: number;
  onRefresh: () => void;
}) {
  const [remaining, setRemaining] = useState(intervalSeconds);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (intervalSeconds <= 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const isVisible = () =>
      typeof document === 'undefined' ||
      document.visibilityState === 'visible';

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        setRemaining((current) => {
          if (current <= 1) {
            onRefreshRef.current();
            return intervalSeconds;
          }
          return current - 1;
        });
      }, 1000);
    };

    const handleVisibilityChange = () => {
      if (isVisible()) {
        setRemaining(intervalSeconds);
        start();
      } else {
        stop();
      }
    };

    setRemaining(intervalSeconds);
    if (isVisible()) start();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener(
          'visibilitychange',
          handleVisibilityChange,
        );
      }
    };
  }, [intervalSeconds]);

  if (intervalSeconds <= 0) return null;
  return <div className="oauth-toolbar-meta">下次刷新 {remaining}s</div>;
}
