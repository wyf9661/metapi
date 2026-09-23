/**
 * Whether the current browser session is reaching the console through the
 * public tunnel rather than the local machine (localhost / a private-LAN
 * address). Any host that is not clearly local is treated as tunnel access:
 * quick-tunnel suffixes change and users can attach their own public
 * hostname (named tunnel), so a suffix allowlist would go stale.
 */
export function isTunnelClientView(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname.toLowerCase().trim();
  if (!host) return false; // file:// or no host — treat as local
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;

  // Pure dotted IPv4 literal → classify by private range.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    return true; // public IP literal
  }

  // Hostname (e.g. origin.wyf9661.dpdns.org, *.trycloudflare.com,
  // *.abc-tunnel.us, any custom domain) — treat as public tunnel access.
  return true;
}
