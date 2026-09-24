import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { isTunnelClientView } from './tunnelView.js';

/**
 * Whether this browser reached the console through the public tunnel. The server
 * is authoritative (it sees the Cloudflare tunnel headers), so callers that
 * already hold `tunnelClientView` from their own response should pass it in and
 * skip the extra request; otherwise it is fetched from /api/tunnel/status, with
 * the hostname heuristic covering only the window before that answer arrives.
 */
export function useTunnelClientView(serverValue?: boolean | null): boolean {
  const [fetched, setFetched] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof serverValue === 'boolean') return;
    let cancelled = false;
    if (typeof api.getTunnelStatus !== 'function') return;
    void api.getTunnelStatus()
      .then((res) => {
        const flag = (res as { tunnelClientView?: unknown } | null)?.tunnelClientView;
        if (!cancelled) setFetched(typeof flag === 'boolean' ? flag : null);
      })
      .catch(() => {
        // Keep the hostname fallback; the server still enforces the policy.
      });
    return () => {
      cancelled = true;
    };
  }, [serverValue]);

  if (typeof serverValue === 'boolean') return serverValue;
  return fetched ?? isTunnelClientView();
}
