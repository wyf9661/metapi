import * as net from 'node:net';
import { promises as dns } from 'node:dns';

/**
 * Shared icon fetching + caching for the web UI.
 *
 * Two sources are proxied through the server rather than hit from the browser:
 * - site favicons: upstreams sit behind Cloudflare/hotlink protection, live on
 *   internal networks, or declare their icon via an absolute CDN URL only the
 *   server can resolve reliably.
 * - brand icons: the lobehub icon CDN is a third-party origin; proxying keeps
 *   the CSP tight and lets one server-side cache serve every browser.
 */

export type IconPayload = {
  buffer: Buffer;
  contentType: string;
  source: string;
};

type CacheEntry = IconPayload & { expiresAt: number };

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 512 * 1024;

const iconCache = new Map<string, CacheEntry>();
const missCache = new Map<string, number>();

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
};

const FAVICON_CANDIDATES = ['/favicon.ico', '/favicon.png', '/logo.svg', '/logo.png'];

const BRAND_ICON_VERSION = '1.83.0';
const BRAND_ICON_CDN_BASE = `https://registry.npmmirror.com/@lobehub/icons-static-png/${BRAND_ICON_VERSION}/files`;

export function __resetIconCacheForTests(): void {
  iconCache.clear();
  missCache.clear();
}

function readCache(key: string): IconPayload | null {
  const entry = iconCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    iconCache.delete(key);
    return null;
  }
  return { buffer: entry.buffer, contentType: entry.contentType, source: entry.source };
}

function writeCache(key: string, payload: IconPayload): void {
  iconCache.set(key, { ...payload, expiresAt: Date.now() + CACHE_TTL_MS });
  missCache.delete(key);
}

/** Remember recent misses so a logo-less site is not re-probed on every render. */
function isNegativelyCached(key: string): boolean {
  const until = missCache.get(key);
  if (!until) return false;
  if (until <= Date.now()) {
    missCache.delete(key);
    return false;
  }
  return true;
}

function markMiss(key: string): void {
  missCache.set(key, Date.now() + NEGATIVE_CACHE_TTL_MS);
}

export function isPrivateHostname(hostname: string): boolean {
  const ip = net.isIP(hostname);
  if (ip === 4) {
    const parts = hostname.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) return true;
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
    return false;
  }
  if (ip === 6) {
    const lower = hostname.toLowerCase();
    if (lower === '::1' || lower === '::' || lower.startsWith('::ffff:')) return true;
    if (lower.startsWith('fe80')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    return false;
  }
  return false;
}

export async function resolvesToPrivate(hostname: string): Promise<boolean> {
  if (isPrivateHostname(hostname)) return true;
  try {
    const { address } = await dns.lookup(hostname, { verbatim: true });
    return isPrivateHostname(address);
  } catch {
    return true; // Be conservative: if DNS fails, refuse to fetch.
  }
}

/** Extract <link rel="...icon..."> hrefs, most logo-like first. */
export function extractIconHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const relPattern = /<link[^>]+rel=["']([^"']*icon[^"']*)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = relPattern.exec(html)) !== null) {
    const tag = match[0];
    const rel = (match[1] || '').toLowerCase();
    const hrefMatch = /\bhref=["']([^"']+)["']/i.exec(tag);
    if (!hrefMatch) continue;
    const href = hrefMatch[1]!.trim();
    if (!href || href.startsWith('#')) continue;
    if (rel.includes('apple-touch-icon') || rel.includes('shortcut')) hrefs.unshift(href);
    else hrefs.push(href);
  }
  return hrefs;
}

function resolveIconUrl(href: string, origin: string): URL | null {
  try {
    const resolved = new URL(href, origin);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved;
  } catch {
    return null;
  }
}

/** Decode an inline `data:image/...;base64,...` icon declaration. */
export function decodeDataUriIcon(href: string): IconPayload | null {
  if (!href.startsWith('data:image/')) return null;
  const comma = href.indexOf(',');
  if (comma <= 0) return null;
  const meta = href.slice(0, comma);
  const contentType = /^data:([^;,]+)/i.exec(meta)?.[1] || 'image/png';
  try {
    const buffer = Buffer.from(href.slice(comma + 1), 'base64');
    if (buffer.length === 0) return null;
    return { buffer, contentType, source: 'data:uri' };
  } catch {
    return null;
  }
}

async function fetchImage(
  target: string | URL,
  referer?: string,
): Promise<IconPayload | null> {
  try {
    const response = await fetch(target, {
      headers: referer ? { ...BROWSER_HEADERS, Referer: referer } : BROWSER_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return null;
    return { buffer, contentType, source: String(target) };
  } catch {
    return null;
  }
}

export type FaviconLookup =
  | { status: 'ok'; payload: IconPayload; cache: 'HIT' | 'MISS' }
  | { status: 'not-found' }
  | { status: 'forbidden' };

/**
 * Resolve a site's favicon, mirroring what a browser does: try the conventional
 * static paths first, then honour the page's own `<link rel="icon">` (which may
 * be an absolute CDN URL or an inline data URI).
 */
export async function lookupSiteFavicon(
  origin: string,
  options: { trustPrivateHost?: boolean } = {},
): Promise<FaviconLookup> {
  const cacheKey = `site:${origin}`;
  const cached = readCache(cacheKey);
  if (cached) return { status: 'ok', payload: cached, cache: 'HIT' };

  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return { status: 'not-found' };
  }
  if (!options.trustPrivateHost && (await resolvesToPrivate(hostname))) {
    return { status: 'forbidden' };
  }

  if (isNegativelyCached(cacheKey)) return { status: 'not-found' };

  for (const candidate of FAVICON_CANDIDATES) {
    const payload = await fetchImage(`${origin}${candidate}`, origin);
    if (payload) {
      const resolved = { ...payload, source: candidate };
      writeCache(cacheKey, resolved);
      return { status: 'ok', payload: resolved, cache: 'MISS' };
    }
  }

  try {
    const page = await fetch(origin, {
      headers: { ...BROWSER_HEADERS, Referer: origin },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (page.ok) {
      const html = (await page.text()).slice(0, MAX_HTML_BYTES);
      for (const href of extractIconHrefs(html)) {
        const inline = decodeDataUriIcon(href);
        if (inline) {
          writeCache(cacheKey, inline);
          return { status: 'ok', payload: inline, cache: 'MISS' };
        }
        const resolvedUrl = resolveIconUrl(href, origin);
        if (!resolvedUrl) continue;
        // A crafted href could point at internal infrastructure; re-check.
        if (await resolvesToPrivate(resolvedUrl.hostname)) continue;
        const payload = await fetchImage(resolvedUrl, origin);
        if (payload) {
          writeCache(cacheKey, payload);
          return { status: 'ok', payload, cache: 'MISS' };
        }
      }
    }
  } catch {
    // Fall through to a miss.
  }

  markMiss(cacheKey);
  return { status: 'not-found' };
}

const BRAND_ICON_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeBrandIconRequest(
  icon: string,
  theme: string | undefined,
): { key: string; theme: 'dark' | 'light' } | null {
  const key = String(icon || '').trim().toLowerCase();
  if (!BRAND_ICON_KEY_PATTERN.test(key)) return null;
  if (key.includes('..')) return null;
  return { key, theme: theme === 'dark' ? 'dark' : 'light' };
}

export type BrandIconLookup =
  | { status: 'ok'; payload: IconPayload; cache: 'HIT' | 'MISS' }
  | { status: 'not-found' };

/** Fetch a lobehub brand icon through the server so it is cached once for all clients. */
export async function lookupBrandIcon(
  key: string,
  theme: 'dark' | 'light',
): Promise<BrandIconLookup> {
  const cacheKey = `brand:${theme}:${key}`;
  const cached = readCache(cacheKey);
  if (cached) return { status: 'ok', payload: cached, cache: 'HIT' };
  if (isNegativelyCached(cacheKey)) return { status: 'not-found' };

  const payload = await fetchImage(`${BRAND_ICON_CDN_BASE}/${theme}/${key}.png`);
  if (!payload) {
    markMiss(cacheKey);
    return { status: 'not-found' };
  }
  const resolved = { ...payload, source: `${theme}/${key}.png` };
  writeCache(cacheKey, resolved);
  return { status: 'ok', payload: resolved, cache: 'MISS' };
}
