import { useEffect, useRef, useState } from 'react';

/**
 * Auto-refresh countdown label with its own tick state.
 *
 * The tick lives here, not in OAuthManagement: while the countdown was
 * top-level state, its 1s interval re-rendered that whole page every second.
 * The timer pauses while the tab is hidden.
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
