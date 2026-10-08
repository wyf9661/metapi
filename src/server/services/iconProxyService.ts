import * as net from 'node:net';
import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { fetch, getSetCookies, type Cookie, type Response } from 'undici';
import { config } from '../config.js';
import { normalizeSiteProxyUrl, withExplicitProxyRequestInit } from './siteProxy.js';
import { withSystemProxyRequestInit } from './systemProxy.js';

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

/**
 * Two layers, deliberately different:
 * - the BROWSER header stays short (1h): a client's stale-icon window remains
 *   small and self-heals without a hard refresh, and the hourly re-request is
 *   answered from the in-process cache in ~ms.
 * - the SERVER cache is long (12h): a miss costs a full page fetch of the
 *   upstream (observed: a 575KB document taking ~6s through the host proxy),
 *   while favicon content almost never changes. The cache is in-memory, so any
 *   restart/deploy ages every entry out anyway — rule changes apply then.
 */
export const ICON_HTTP_MAX_AGE_SECONDS = 60 * 60;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 512 * 1024;
/** Cap any single downloaded icon; a legit favicon is a few KB, not hundreds of MB. */
const MAX_ICON_BYTES = 512 * 1024;
const MAX_ICON_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const iconCache = new Map<string, CacheEntry>();
const missCache = new Map<string, number>();
/**
 * In-flight de-duplication. The usage-log page renders one badge per row, so a
 * cold cache turns ten rows of the same site into ten simultaneous upstream
 * fetches (measured: nine concurrent cold favicon requests for one site, 3-8s
 * each, ~6-8s wall — every one of them reading the same page). One fetch is
 * enough; the rest await the same promise.
 */
const inflight = new Map<string, Promise<unknown>>();
/**
 * Second-level cache on disk. The in-process cache dies with the process, so
 * every restart/deploy (including a hot-swap of the server bundle) re-fetched
 * every icon on the next page view. Persisting the SAME 12h window keeps the
 * in-memory semantics unchanged — the file is only consulted after an in-memory
 * miss — and makes a restart cost nothing.
 *
 * The directory is version-scoped on purpose: the old design relied on a
 * restart to age every entry out, which is how a favicon-resolution rule change
 * (order, ranking, candidates) or a lobehub icon CDN bump took effect. Bump
 * ICON_DISK_CACHE_VERSION in the same change that alters resolution rules, and
 * every previously written entry is ignored from then on.
 */
const ICON_DISK_CACHE_VERSION = 'v1';
let diskCacheDirReady = false;

function diskCacheDir(): string {
  return join(config.dataDir, 'icon-cache', ICON_DISK_CACHE_VERSION);
}

function diskCachePath(key: string): string {
  return join(diskCacheDir(), `${createHash('sha256').update(key).digest('hex')}.json`);
}

function readDiskCache(key: string): IconPayload | null {
  const path = diskCachePath(key);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      expiresAt?: number;
      contentType?: string;
      source?: string;
      buffer?: string;
    };
    if (!parsed.expiresAt || parsed.expiresAt <= Date.now()) {
      // Expired: drop the file so the directory does not grow without bound.
      try { unlinkSync(path); } catch { /* best effort */ }
      return null;
    }
    if (!parsed.contentType || typeof parsed.buffer !== 'string') return null;
    return {
      buffer: Buffer.from(parsed.buffer, 'base64'),
      contentType: parsed.contentType,
      source: parsed.source || 'disk-cache',
    };
  } catch {
    return null;
  }
}

function writeDiskCache(key: string, payload: IconPayload, expiresAt: number): void {
  try {
    if (!diskCacheDirReady) {
      mkdirSync(diskCacheDir(), { recursive: true });
      diskCacheDirReady = true;
    }
    writeFileSync(
      diskCachePath(key),
      JSON.stringify({
        expiresAt,
        contentType: payload.contentType,
        source: payload.source,
        buffer: payload.buffer.toString('base64'),
      }),
      'utf8',
    );
  } catch {
    // A disk cache is an optimisation: never let a read-only FS / full disk
    // break icon serving, and don't retry the mkdir on every write.
    diskCacheDirReady = existsSync(diskCacheDir());
  }
}

/** Share one upstream fetch between concurrent callers of the same cache key. */
function dedupeInFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = run().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

/** Drop only the in-memory layer — models a process restart with the disk cache intact. */
export function __clearIconMemoryCacheForTests(): void {
  iconCache.clear();
  missCache.clear();
  inflight.clear();
}

export function __resetIconCacheForTests(): void {
  __clearIconMemoryCacheForTests();
  // The disk layer must reset too, or a neighbouring test that shares the same
  // DATA_DIR sees another case's entry and the MISS/HIT assertions flip.
  try {
    rmSync(diskCacheDir(), { recursive: true, force: true });
    diskCacheDirReady = false;
  } catch {
    /* nothing on disk */
  }
}

function readCache(key: string): IconPayload | null {
  const entry = iconCache.get(key);
  if (entry) {
    if (entry.expiresAt <= Date.now()) {
      iconCache.delete(key);
    } else {
      return { buffer: entry.buffer, contentType: entry.contentType, source: entry.source };
    }
  }
  // In-memory miss: the disk layer (survives restarts) is consulted before we
  // pay for an upstream fetch, and a hit rehydrates the in-memory entry.
  const fromDisk = readDiskCache(key);
  if (fromDisk) {
    iconCache.set(key, { ...fromDisk, expiresAt: Date.now() + CACHE_TTL_MS });
    return fromDisk;
  }
  return null;
}

function writeCache(key: string, payload: IconPayload): void {
  const expiresAt = Date.now() + CACHE_TTL_MS;
  iconCache.set(key, { ...payload, expiresAt });
  missCache.delete(key);
  writeDiskCache(key, payload, expiresAt);
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
};

const FAVICON_CONVENTIONAL_PATH = '/favicon.ico';

/**
 * Compatibility sweep for self-hosted deployments that serve a logo file but
 * never declare it. Browsers do NOT probe these; they run only after the page's
 * own declaration and `/favicon.ico` both failed, which is what makes this proxy
 * more forgiving than a browser without being slower for the common case.
 */
const FAVICON_COMPAT_CANDIDATES = ['/favicon.png', '/favicon.svg', '/logo.svg', '/logo.png'];

export const BRAND_ICON_VERSION = '1.97.0';
export const BRAND_ICON_CDN_BASE = `https://registry.npmmirror.com/@lobehub/icons-static-png/${BRAND_ICON_VERSION}/files`;

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
    const addresses = await dns.lookup(hostname, { verbatim: true, all: true });
    return addresses.length === 0 || addresses.every((a) => isPrivateHostname(a.address));
  } catch {
    return true; // Be conservative: if DNS fails, refuse to fetch.
  }
}

/**
 * Declared icon links, ranked the way a browser picks a tab icon:
 * a declared `<link rel="icon">` beats anything at a conventional path, a large
 * or SVG icon beats a small raster one, and Apple's touch icons beat a legacy
 * 16px favicon. Inline `data:` icons rank last — browsers render them, but a real
 * URL is preferable whenever one works, and this keeps the decoded-blob cases to
 * sites that truly declare nothing else.
 */
const ICON_REL_RANK: Record<string, number> = {
  icon: 300,
  'shortcut icon': 290,
  'apple-touch-icon': 200,
  'apple-touch-icon-precomposed': 190,
  'mask-icon': 100,
};

export type IconLinkCandidate = {
  href: string;
  rank: number;
  inline: boolean;
};

function readTagAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    attributes[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

/** Largest declared square size: `sizes="32x32 16x16"` → 32, `sizes="any"` → 0. */
function readDeclaredIconSize(sizes: string): number {
  let largest = 0;
  for (const match of sizes.matchAll(/(\d+)\s*[xX]\s*(\d+)/g)) {
    largest = Math.max(largest, Number(match[1]), Number(match[2]));
  }
  return largest;
}

export function extractIconCandidates(html: string): IconLinkCandidate[] {
  const candidates: IconLinkCandidate[] = [];
  const linkPattern = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null) {
    const attributes = readTagAttributes(match[0]);
    const rel = (attributes.rel || '').trim().toLowerCase();
    if (!rel.includes('icon')) continue;
    const href = (attributes.href || '').trim();
    if (!href || href.startsWith('#')) continue;

    const inline = href.startsWith('data:');
    let rank = ICON_REL_RANK[rel]
      ?? (rel.includes('shortcut') ? 280 : (rel.includes('apple') ? 180 : 150));
    if (inline) rank -= 100;
    const type = (attributes.type || '').toLowerCase();
    if (type.includes('svg') || /\.svg(?:[?#]|$)/i.test(href)) rank += 40;
    rank += (Math.min(readDeclaredIconSize(attributes.sizes || ''), 512) / 512) * 30;

    candidates.push({ href, rank, inline });
  }
  return candidates.sort((left, right) => right.rank - left.rank);
}

/** Extract `<link rel="...icon...">` hrefs, most logo-like first. */
export function extractIconHrefs(html: string): string[] {
  return extractIconCandidates(html).map((candidate) => candidate.href);
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

/**
 * Inline `data:` icons travel inside the page. A reasonable one is served as
 * eagerly as a URL icon, but a big blob is a real cost: one relay inlines a
 * 205KB JPEG (observed live) and every client would pay for it on a 16px badge.
 * Blobs above the eager cap are therefore DEFERRED rather than discarded — the
 * browser tab renders them, so they are used once the page, `/favicon.ico` and
 * the compatibility sweep all come up empty. The ceiling keeps a pathological
 * document from turning into a download.
 */
const MAX_INLINE_ICON_BYTES = 64 * 1024;
const MAX_INLINE_ICON_FALLBACK_BYTES = 512 * 1024;

/** Decode an inline `data:image/...;base64,...` icon declaration. */
export function decodeDataUriIcon(
  href: string,
  maxBytes: number = MAX_INLINE_ICON_BYTES,
): IconPayload | null {
  if (!href.startsWith('data:image/')) return null;
  const comma = href.indexOf(',');
  if (comma <= 0) return null;
  const meta = href.slice(0, comma);
  const contentType = /^data:([^;,]+)/i.exec(meta)?.[1] || 'image/png';
  const encoded = href.slice(comma + 1);
  // Estimate the decoded size before decoding: the last-resort pass re-examines
  // a blob the eager pass already rejected, and decoding it twice is waste.
  if (Math.floor((encoded.length * 3) / 4) > maxBytes) return null;
  try {
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.length === 0) return null;
    if (buffer.length > maxBytes) return null;
    return { buffer, contentType, source: 'data:uri' };
  } catch {
    return null;
  }
}

type RedirectCookie = Cookie & { origin: string; path: string; expiresAt: number };

async function fetchIconResource(
  target: string | URL,
  referer?: string,
  proxyUrl?: string | null,
): Promise<Response | null> {
  let url = new URL(target);
  const initialOrigin = url.origin;
  const cookies = new Map<string, RedirectCookie>();
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  // Redirect cookies belong to this anonymous fetch only, never to an account
  // or another origin. Every hop retains the same explicitly selected proxy.
  for (let hop = 0; hop <= MAX_ICON_REDIRECTS; hop += 1) {
    if (url.origin !== initialOrigin && await resolvesToPrivate(url.hostname)) return null;
    const cookieHeader = [...cookies.values()]
      .filter((cookie) => cookie.origin === url.origin
        && (!cookie.secure || url.protocol === 'https:')
        && cookie.expiresAt > Date.now()
        && (url.pathname === cookie.path
          || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)))
      .sort((left, right) => right.path.length - left.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    // A site proxy wins when the operator configured one. Otherwise fall back to
    // the first-party system proxy (HTTPS_PROXY/HTTP_PROXY…) the same way the
    // update-center fetches do: `siteProxy` installs a FORCED-DIRECT global
    // dispatcher, so without this an upstream that is only reachable through the
    // host's proxy times out here, and the lookup silently degrades to a guessed
    // path (observed: a relay whose page declares its logo inline resolved to an
    // unrelated /logo.svg because the page fetch never completed).
    const requestInit = {
      headers: {
        ...BROWSER_HEADERS,
        ...(referer ? { Referer: referer } : {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      signal,
      redirect: 'manual' as const,
    };
    const response = await fetch(
      url,
      proxyUrl
        ? withExplicitProxyRequestInit(proxyUrl, requestInit)
        : withSystemProxyRequestInit(process.env, requestInit),
    );
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    for (const cookie of getSetCookies(response.headers)) {
      const domain = cookie.domain?.replace(/^\./, '').toLowerCase();
      if (domain && url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) continue;
      const path = cookie.path?.startsWith('/')
        ? cookie.path
        : url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
      const expiresAt = cookie.maxAge !== undefined
        ? Date.now() + cookie.maxAge * 1000
        : cookie.expires ? new Date(cookie.expires).getTime() : Number.POSITIVE_INFINITY;
      cookies.set(`${url.origin}\0${path}\0${cookie.name}`, { ...cookie, origin: url.origin, path, expiresAt });
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || hop === MAX_ICON_REDIRECTS) return null;
    const next = resolveIconUrl(location, url.toString());
    if (!next || next.username || next.password) return null;
    if (url.protocol === 'https:' && next.protocol !== 'https:') return null;
    url = next;
  }
  return null;
}

async function fetchImage(
  target: string | URL,
  referer?: string,
  proxyUrl?: string | null,
): Promise<IconPayload | null> {
  try {
    const response = await fetchIconResource(target, referer, proxyUrl);
    if (!response) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.startsWith('image/')) {
      await response.body?.cancel();
      return null;
    }
    // Enforce the byte cap while streaming: aborting the read as soon as the
    // cap is crossed stops a huge or infinite body from filling memory.
    const declaredLength = Number(response.headers.get('content-length') || '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ICON_BYTES) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Buffer[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_ICON_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) return null;
    return { buffer, contentType, source: String(target) };
  } catch {
    return null;
  }
}

/** Cache a resolved icon and shape the success result. */
function acceptFavicon(cacheKey: string, payload: IconPayload): FaviconLookup {
  writeCache(cacheKey, payload);
  return { status: 'ok', payload, cache: 'MISS' };
}

type DeclaredIconResolution = {
  /** The declared icon a browser would use, when we can serve it as-is. */
  chosen: IconPayload | null;
  /** An inline `data:` icon above the eager cap, kept as a last resort. */
  oversizedInline: IconPayload | null;
};

/**
 * Read the page at the origin and return the first declared icon that actually
 * resolves, in browser preference order (see extractIconCandidates). Only an HTML
 * document can declare icons, so an image or JSON response at the root is ignored
 * instead of being scanned for `<link>` tags that cannot be there.
 */
async function resolveDeclaredPageIcon(
  origin: string,
  proxyUrl: string | null,
): Promise<DeclaredIconResolution> {
  const none: DeclaredIconResolution = { chosen: null, oversizedInline: null };
  try {
    const page = await fetchIconResource(origin, origin, proxyUrl);
    if (!page) return none;
    if (!page.ok) {
      await page.body?.cancel();
      return none;
    }
    const contentType = (page.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('html')) {
      await page.body?.cancel();
      return none;
    }

    const html = (await page.text()).slice(0, MAX_HTML_BYTES);
    let oversizedInline: IconPayload | null = null;
    for (const candidate of extractIconCandidates(html)) {
      if (candidate.inline) {
        const inline = decodeDataUriIcon(candidate.href);
        if (inline) return { chosen: inline, oversizedInline: null };
        oversizedInline ??= decodeDataUriIcon(candidate.href, MAX_INLINE_ICON_FALLBACK_BYTES);
        continue;
      }
      const resolvedUrl = resolveIconUrl(candidate.href, origin);
      if (!resolvedUrl) continue;
      // A crafted href could point at internal infrastructure; re-check.
      if (await resolvesToPrivate(resolvedUrl.hostname)) continue;
      const payload = await fetchImage(resolvedUrl, origin, proxyUrl);
      if (payload) return { chosen: payload, oversizedInline: null };
    }
    return { chosen: null, oversizedInline };
  } catch {
    // A page we cannot read simply declares nothing.
  }
  return none;
}

/** Resolve only an administrator-configured site on the requested origin. */
export async function resolveFaviconSite(origin: string, siteId?: number) {
  const rows = await db
    .select({ id: schema.sites.id, url: schema.sites.url, proxyUrl: schema.sites.proxyUrl })
    .from(schema.sites)
    .where(siteId === undefined ? undefined : eq(schema.sites.id, siteId))
    .orderBy(asc(schema.sites.id))
    .all();
  const matches = rows.filter((site) => {
    try { return new URL(site.url).origin === origin; } catch { return false; }
  });
  return matches.find((site) => site.url.replace(/\/+$/, '') === origin) ?? matches[0] ?? null;
}

export type FaviconLookup =
  | { status: 'ok'; payload: IconPayload; cache: 'HIT' | 'MISS' }
  | { status: 'not-found' }
  | { status: 'forbidden' };

/**
 * Resolve a site's favicon the way a browser does, in four ordered steps:
 *   1. read the page and honour its declared `<link rel="icon">` (any variant,
 *      including an absolute CDN URL, an SVG or an inline data URI);
 *   2. accept an oversized inline `data:` icon — the page declared it; the
 *      browser shows it, so guessing a legacy path would disagree;
 *   3. fall back to the one conventional path, `/favicon.ico`;
 *   4. only then sweep non-standard logo paths, which browsers never probe.
 *
 * Order matters for both quality and cost: the previous implementation probed
 * four guessed static paths before even looking at the document, so a site with a
 * declared SVG logo could still be served a 16px `.ico`, and a site without one
 * paid four timed-out requests before the page was ever read.
 */
export async function lookupSiteFavicon(
  origin: string,
  options: { trustPrivateHost?: boolean; proxyUrl?: string | null } = {},
): Promise<FaviconLookup> {
  const proxyUrl = normalizeSiteProxyUrl(options.proxyUrl);
  const cacheKey = `site:${origin}:${proxyUrl || 'direct'}:${!!options.trustPrivateHost}`;
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

  // One upstream resolution per key: ten usage-log rows of the same site must
  // not launch ten page fetches (see `inflight`).
  return dedupeInFlight(cacheKey, async () => {
    // 1. What the page itself declares — the first thing a browser reads, and the
    //    only source that can point at a CDN URL, an SVG or an inline icon.
    const declared = await resolveDeclaredPageIcon(origin, proxyUrl);
    if (declared.chosen) return acceptFavicon(cacheKey, declared.chosen);

    // 2. An inline `data:` icon too large to serve eagerly, but declared by the
    //    page — the browser shows it in the tab, so using /favicon.ico or a
    //    guess-path logo instead would disagree with the browser. Accepting it
    //    here, before probing undeclared paths, preserves the browser's icon
    //    preference (page declaration beats all guesswork).
    if (declared.oversizedInline) return acceptFavicon(cacheKey, declared.oversizedInline);

    // 3. The one conventional path a browser falls back to when the page declares
    //    nothing. It is intentionally requested after (not before) the document:
    //    a declared SVG logo beats a 16px legacy .ico, and guessing static paths
    //    first was what made this lookup slow and lossy.
    const conventional = await fetchImage(`${origin}${FAVICON_CONVENTIONAL_PATH}`, origin, proxyUrl);
    if (conventional) return acceptFavicon(cacheKey, conventional);

    // 4. Compatibility sweep for deployments that never declare an icon and do not
    //    ship the conventional one (self-hosted NewAPI instances typically serve a
    //    logo file at the root instead).
    for (const candidate of FAVICON_COMPAT_CANDIDATES) {
      const payload = await fetchImage(`${origin}${candidate}`, origin, proxyUrl);
      if (payload) return acceptFavicon(cacheKey, { ...payload, source: candidate });
    }

    markMiss(cacheKey);
    return { status: 'not-found' as const };
  });
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

  return dedupeInFlight(cacheKey, async () => {
    // Re-check: the caller we shared the promise with may have been the one that
    // filled the cache. (Cheap, and keeps the HIT/MISS header honest.)
    const raced = readCache(cacheKey);
    if (raced) return { status: 'ok' as const, payload: raced, cache: 'HIT' as const };

    const payload = await fetchImage(`${BRAND_ICON_CDN_BASE}/${theme}/${key}.png`);
    if (!payload) {
      markMiss(cacheKey);
      return { status: 'not-found' as const };
    }
    const resolved = { ...payload, source: `${theme}/${key}.png` };
    writeCache(cacheKey, resolved);
    return { status: 'ok' as const, payload: resolved, cache: 'MISS' as const };
  });
}
