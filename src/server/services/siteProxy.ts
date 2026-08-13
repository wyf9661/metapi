import { AsyncLocalStorage } from 'node:async_hooks';
import { db, schema } from '../db/index.js';
import { lookup as dnsLookup } from 'node:dns';
import { isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { SocksClient } from 'socks';
import type { Dispatcher, RequestInit as UndiciRequestInit } from 'undici';
import { Agent as UndiciAgent, ProxyAgent, setGlobalDispatcher, Agent } from 'undici';
import { mergeHeadersWithSiteCustomHeaders, type SiteCustomHeadersMergePriority } from './siteCustomHeaders.js';
import { resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { stripTrailingSlashes } from './urlNormalization.js';
import { parseSiteProtocolProfile } from '../shared/siteProtocolProfile.js';

// Global keep-alive Agent for direct (non-proxy) upstream requests.
// This enables HTTP/1.1 keep-alive across all upstream fetches that don't
// go through a proxy dispatcher, reducing TLS handshake overhead.
const globalNonProxyAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 300_000,
  connections: 128,
  pipelining: 5,
  connect: { rejectUnauthorized: true },
});

setGlobalDispatcher(globalNonProxyAgent);

const SITE_PROXY_CACHE_TTL_MS = 3_000;
// Proxy dispatchers (ProxyAgent / SOCKS) hold keep-alive sockets and TLS
// state. Cache them for reuse but expire idle entries so long-running
// instances do not accumulate unbounded sockets for one-off proxy URLs.
const DISPATCHER_CACHE_TTL_MS = 10 * 60 * 1000;

type DispatcherCacheEntry = {
  dispatcher: Dispatcher;
  lastUsedAtMs: number;
};

const dispatcherCache = new Map<string, DispatcherCacheEntry>();
const DISPATCHER_CACHE_SWEEP_MS = 60_000;
let dispatcherCacheSweepTimer: ReturnType<typeof setInterval> | null = null;

function sweepExpiredDispatchers(nowMs = Date.now()): void {
  for (const [key, entry] of dispatcherCache.entries()) {
    if (nowMs - entry.lastUsedAtMs > DISPATCHER_CACHE_TTL_MS) {
      dispatcherCache.delete(key);
      closeDispatcherIfPossible(entry.dispatcher);
    }
  }
}

function ensureDispatcherCacheSweep(): void {
  if (dispatcherCacheSweepTimer) return;
  dispatcherCacheSweepTimer = setInterval(() => {
    sweepExpiredDispatchers();
  }, DISPATCHER_CACHE_SWEEP_MS);
  dispatcherCacheSweepTimer.unref?.();
}
const SUPPORTED_PROXY_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);
const SOCKS_PROXY_PROTOCOLS = new Set([
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);
const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PROXY_KEEPALIVE_INITIAL_DELAY_MS = 60_000;

type SiteProxyRow = {
  siteUrl: string;
  proxyUrl: string | null;
  customHeaders: unknown;
  customHeadersOverrideRequestHeaders: boolean;
  protocolProfile: unknown;
};
type SiteProxyQueryRow = {
  siteUrl: string;
  proxyUrl: string | null;
  customHeaders: unknown;
  customHeadersOverrideRequestHeaders: boolean | null;
  protocolProfile: unknown;
};

type ParsedSiteProxyInput = {
  present: boolean;
  valid: boolean;
  proxyUrl: string | null;
};

export type SiteProxyConfigLike = {
  proxyUrl?: string | null;
  customHeaders?: unknown;
  customHeadersOverrideRequestHeaders?: boolean | null;
  protocolProfile?: unknown;
};

let siteProxyCache: {
  loadedAt: number;
  rows: SiteProxyRow[];
} = {
  loadedAt: 0,
  rows: [],
};

const accountProxyOverride = new AsyncLocalStorage<string | null>();

export function withAccountProxyOverride<T>(
  proxyUrl: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return fn();
  return accountProxyOverride.run(normalized, fn);
}

type ParsedSocksProxyConfig = {
  shouldLookup: boolean;
  proxy: {
    host: string;
    port: number;
    type: 4 | 5;
    userId?: string;
    password?: string;
  };
};

type UndiciConnectOptions = {
  hostname: string;
  host?: string;
  protocol: string;
  port: string;
  servername?: string;
  localAddress?: string | null;
  httpSocket?: Socket;
};

export function normalizeSiteUrl(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    const normalizedPath = stripTrailingSlashes(parsed.pathname);
    return `${parsed.origin}${normalizedPath}`;
  } catch {
    return stripTrailingSlashes(trimmed);
  }
}

async function getCachedSiteProxyRows(nowMs = Date.now()): Promise<SiteProxyRow[]> {
  if ((nowMs - siteProxyCache.loadedAt) < SITE_PROXY_CACHE_TTL_MS) {
    return siteProxyCache.rows;
  }

  try {
    const rows = await db
      .select({
        siteUrl: schema.sites.url,
        proxyUrl: schema.sites.proxyUrl,
        customHeaders: schema.sites.customHeaders,
        customHeadersOverrideRequestHeaders: schema.sites.customHeadersOverrideRequestHeaders,
        protocolProfile: schema.sites.protocolProfile,
      })
      .from(schema.sites)
      .all() as SiteProxyQueryRow[];

    siteProxyCache = {
      loadedAt: nowMs,
      rows: rows.map((row) => ({
        siteUrl: normalizeSiteUrl(row.siteUrl),
        proxyUrl: normalizeSiteProxyUrl(row.proxyUrl),
        customHeaders: row.customHeaders ?? null,
        customHeadersOverrideRequestHeaders: !!row.customHeadersOverrideRequestHeaders,
        protocolProfile: row.protocolProfile ?? null,
      })),
    };
  } catch {
    siteProxyCache = { loadedAt: nowMs, rows: [] };
  }

  return siteProxyCache.rows;
}

function closeDispatcherIfPossible(dispatcher: Dispatcher | undefined): void {
  if (dispatcher && typeof (dispatcher as { close?: () => Promise<void> | void }).close === 'function') {
    try {
      void (dispatcher as { close: () => Promise<void> | void }).close();
    } catch {
      // Best-effort socket teardown; ignore close failures.
    }
  }
}

function getDispatcherByProxyUrl(proxyUrl: string, skipCache = false): Dispatcher | undefined {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return undefined;

  if (!skipCache) {
    const nowMs = Date.now();
    const cached = dispatcherCache.get(normalized);
    if (cached) {
      if (nowMs - cached.lastUsedAtMs > DISPATCHER_CACHE_TTL_MS) {
        // Idle entry expired: tear down its sockets and evict.
        dispatcherCache.delete(normalized);
        closeDispatcherIfPossible(cached.dispatcher);
      } else {
        cached.lastUsedAtMs = nowMs;
        return cached.dispatcher;
      }
    }
  }

  try {
    const parsedProxyUrl = new URL(normalized);
    const dispatcher = SOCKS_PROXY_PROTOCOLS.has(parsedProxyUrl.protocol.toLowerCase())
      ? createSocksDispatcher(parsedProxyUrl)
      : new ProxyAgent(normalized);
    if (!skipCache) {
      dispatcherCache.set(normalized, {
        dispatcher,
        lastUsedAtMs: Date.now(),
      });
      ensureDispatcherCacheSweep();
    }
    return dispatcher;
  } catch {
    return undefined;
  }
}

function parseSocksProxyUrl(proxyUrl: URL): ParsedSocksProxyConfig {
  let shouldLookup = false;
  let type: 4 | 5 = 5;

  switch (proxyUrl.protocol.toLowerCase()) {
    case 'socks4:':
      shouldLookup = true;
      type = 4;
      break;
    case 'socks4a:':
      type = 4;
      break;
    case 'socks5:':
      shouldLookup = true;
      type = 5;
      break;
    case 'socks:':
    case 'socks5h:':
      type = 5;
      break;
    default:
      throw new TypeError(`Unsupported SOCKS proxy protocol: ${proxyUrl.protocol}`);
  }

  const proxy: ParsedSocksProxyConfig['proxy'] = {
    host: proxyUrl.hostname,
    port: Number.parseInt(proxyUrl.port, 10) || 1080,
    type,
  };

  if (proxyUrl.username) {
    proxy.userId = decodeURIComponent(proxyUrl.username);
  }
  if (proxyUrl.password) {
    proxy.password = decodeURIComponent(proxyUrl.password);
  }

  return { shouldLookup, proxy };
}

function applySocketDefaults(socket: Socket | TLSSocket) {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, DEFAULT_PROXY_KEEPALIVE_INITIAL_DELAY_MS);
}

async function resolveSocksDestinationHost(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, {}, (error, address) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(address);
    });
  });
}

async function createSocksSocket(
  connectOptions: UndiciConnectOptions,
  socksProxy: ParsedSocksProxyConfig,
): Promise<Socket | TLSSocket> {
  if (!connectOptions.hostname) {
    throw new Error('Missing hostname for SOCKS proxy request');
  }

  const destinationHost = socksProxy.shouldLookup
    ? await resolveSocksDestinationHost(connectOptions.hostname)
    : connectOptions.hostname;
  const destinationPort = Number.parseInt(connectOptions.port, 10)
    || (connectOptions.protocol === 'https:' ? 443 : 80);

  const { socket } = await SocksClient.createConnection({
    proxy: socksProxy.proxy,
    destination: {
      host: destinationHost,
      port: destinationPort,
    },
    command: 'connect',
    timeout: DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
    socket_options: connectOptions.localAddress
      ? { localAddress: connectOptions.localAddress } as any
      : undefined,
  });
  applySocketDefaults(socket);

  if (connectOptions.protocol !== 'https:') {
    return socket;
  }

  return await new Promise<TLSSocket>((resolve, reject) => {
    const tlsSocket = tlsConnect({
      socket,
      host: connectOptions.hostname,
      servername: connectOptions.servername || (!isIP(connectOptions.hostname) ? connectOptions.hostname : undefined),
      ALPNProtocols: ['http/1.1'],
    });

    const cleanup = (error: Error) => {
      socket.destroy();
      tlsSocket.destroy();
      reject(error);
    };

    tlsSocket.once('secureConnect', () => {
      tlsSocket.off('error', cleanup);
      applySocketDefaults(tlsSocket);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', cleanup);
  });
}

function createSocksDispatcher(proxyUrl: URL): Dispatcher {
  const socksProxy = parseSocksProxyUrl(proxyUrl);
  return new UndiciAgent({
    connect: (connectOptions, callback) => {
      void createSocksSocket(connectOptions, socksProxy)
        .then((socket) => callback(null, socket))
        .catch((error) => {
          callback(error instanceof Error ? error : new Error(String(error)), null as any);
        });
    },
  });
}

export function normalizeSiteProxyUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return null;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function parseSiteProxyUrlInput(input: unknown): ParsedSiteProxyInput {
  if (input === undefined) {
    return { present: false, valid: true, proxyUrl: null };
  }
  if (input === null) {
    return { present: true, valid: true, proxyUrl: null };
  }

  if (typeof input !== 'string') {
    return { present: true, valid: false, proxyUrl: null };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { present: true, valid: true, proxyUrl: null };
  }

  const normalized = normalizeSiteProxyUrl(trimmed);
  if (!normalized) {
    return { present: true, valid: false, proxyUrl: null };
  }

  return {
    present: true,
    valid: true,
    proxyUrl: normalized,
  };
}

export function invalidateSiteProxyCache(): void {
  siteProxyCache = { loadedAt: 0, rows: [] };
}

function findBestMatchingSiteRow(rows: SiteProxyRow[], normalizedRequestUrl: string): SiteProxyRow | null {
  let bestMatch: SiteProxyRow | null = null;
  let bestMatchLength = -1;

  for (const row of rows) {
    if (!row.siteUrl) continue;

    const isPrefixMatch = (
      normalizedRequestUrl === row.siteUrl
      || normalizedRequestUrl.startsWith(`${row.siteUrl}/`)
      || normalizedRequestUrl.startsWith(`${row.siteUrl}?`)
    );
    if (!isPrefixMatch) continue;

    if (row.siteUrl.length > bestMatchLength) {
      bestMatch = row;
      bestMatchLength = row.siteUrl.length;
    }
  }

  return bestMatch;
}

async function resolveSiteRequestConfigByRequestUrl(requestUrl: string): Promise<{
  proxyUrl: string | null;
  customHeaders: unknown;
  customHeadersOverrideRequestHeaders: boolean;
  protocolProfile: unknown;
}> {
  const normalizedRequestUrl = normalizeSiteUrl(requestUrl);
  if (!normalizedRequestUrl) {
    return { proxyUrl: null, customHeaders: null, customHeadersOverrideRequestHeaders: false, protocolProfile: null };
  }

  const rows = await getCachedSiteProxyRows();
  const matchedRow = findBestMatchingSiteRow(rows, normalizedRequestUrl);
  const proxyUrl = matchedRow?.proxyUrl;
  return {
    proxyUrl: proxyUrl || null,
    customHeaders: matchedRow?.customHeaders ?? null,
    customHeadersOverrideRequestHeaders: !!matchedRow?.customHeadersOverrideRequestHeaders,
    protocolProfile: matchedRow?.protocolProfile ?? null,
  };
}


/**
 * Codex client fingerprints are only valid for OpenAI protocol endpoints
 * (/v1/responses, /v1/chat/completions, ...). NewAPI management APIs like
 * /api/user/self reject them with codex_requires_responses_protocol, which
 * previously made session token verification look like a 10s network timeout.
 */
function shouldApplyCodexClientCustomHeaders(requestUrl: string): boolean {
  try {
    const path = new URL(requestUrl).pathname.toLowerCase();
    if (path === '/v1' || path.startsWith('/v1/')) return true;
    if (path === '/openai' || path.startsWith('/openai/')) return true;
    if (path.includes('/backend-api/codex')) return true;
    return false;
  } catch {
    const lower = String(requestUrl || '').toLowerCase();
    return lower.includes('/v1/') || lower.includes('/openai/') || lower.includes('/backend-api/codex');
  }
}

function isCodexClientCustomHeaderName(name: string): boolean {
  const key = name.trim().toLowerCase();
  return key === 'user-agent' || key === 'originator' || key.startsWith('x-codex-');
}

/**
 * Strip Codex client fingerprint headers (user-agent / originator / x-codex-*)
 * from a site's custom headers. When a site runs in Codex compatibility mode
 * the runtime injects the complete, version-consistent Codex fingerprint
 * (ensureCodexClientFingerprintHeaders). A stale user-agent/originator written
 * in custom_headers would override that and produce an inconsistent upstream
 * fingerprint (e.g. UA 0.39.0 + Version 0.101.0) that OpenAI rejects.
 * Returns a new headers record without those keys, or null when empty.
 */
function stripCodexClientFingerprintHeaders(
  customHeaders: unknown,
): unknown {
  if (customHeaders == null) return customHeaders;
  let record: Record<string, unknown> | null = null;
  let isString = false;
  if (typeof customHeaders === 'string') {
    const trimmed = customHeaders.trim();
    if (!trimmed) return customHeaders;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
      isString = true;
    } catch {
      return customHeaders;
    }
  } else if (typeof customHeaders === 'object' && !Array.isArray(customHeaders)) {
    record = customHeaders as Record<string, unknown>;
  } else {
    return customHeaders;
  }

  let removed = false;
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isCodexClientCustomHeaderName(key)) {
      removed = true;
      continue;
    }
    filtered[key] = value;
  }
  if (!removed) return customHeaders;
  if (Object.keys(filtered).length === 0) return null;
  return isString ? JSON.stringify(filtered) : filtered;
}

function filterCustomHeadersForRequestUrl(requestUrl: string, customHeaders: unknown): unknown {
  if (shouldApplyCodexClientCustomHeaders(requestUrl)) return customHeaders;
  if (customHeaders == null) return customHeaders;

  let record: Record<string, unknown> | null = null;
  if (typeof customHeaders === 'string') {
    const trimmed = customHeaders.trim();
    if (!trimmed) return customHeaders;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return customHeaders;
      record = parsed as Record<string, unknown>;
    } catch {
      return customHeaders;
    }
  } else if (typeof customHeaders === 'object' && !Array.isArray(customHeaders)) {
    record = customHeaders as Record<string, unknown>;
  } else {
    return customHeaders;
  }

  const filtered: Record<string, unknown> = {};
  let removed = false;
  for (const [key, value] of Object.entries(record)) {
    if (isCodexClientCustomHeaderName(key)) {
      removed = true;
      continue;
    }
    filtered[key] = value;
  }
  if (!removed) return customHeaders;
  if (Object.keys(filtered).length === 0) return null;
  return typeof customHeaders === 'string' ? JSON.stringify(filtered) : filtered;
}

function resolveSiteCustomHeadersMergePriority(
  _site: Pick<SiteProxyConfigLike, 'customHeadersOverrideRequestHeaders'> | null | undefined,
): SiteCustomHeadersMergePriority {
  // Fixed to 'request': site custom headers never override outbound request
  // headers (e.g. User-Agent, Authorization). The codex fingerprint is
  // injected at the upstreamRequestBuilder layer and must not be overwritten.
  return 'request';
}

export async function resolveSiteProxyUrlByRequestUrl(requestUrl: string): Promise<string | null> {
  const resolved = await resolveSiteRequestConfigByRequestUrl(requestUrl);
  return resolved.proxyUrl;
}

export async function withSiteProxyRequestInit(
  requestUrl: string,
  options?: UndiciRequestInit,
): Promise<UndiciRequestInit> {
  const resolved = await resolveSiteRequestConfigByRequestUrl(requestUrl);
  const nextOptions: UndiciRequestInit = {
    ...(options || {}),
  };
  const profile = parseSiteProtocolProfile(resolved.protocolProfile);
  const effectiveCustomHeaders = profile.requireCodexClient
    ? stripCodexClientFingerprintHeaders(resolved.customHeaders)
    : resolved.customHeaders;
  const mergedHeaders = mergeHeadersWithSiteCustomHeaders(
    filterCustomHeadersForRequestUrl(requestUrl, effectiveCustomHeaders),
    options?.headers,
    {
      priority: resolveSiteCustomHeadersMergePriority(resolved),
    },
  );
  if (mergedHeaders) {
    nextOptions.headers = mergedHeaders;
  }

  const alsOverride = accountProxyOverride.getStore();
  const proxyUrl = alsOverride ?? resolved.proxyUrl;

  if (!proxyUrl) {
    return nextOptions;
  }

  const dispatcher = getDispatcherByProxyUrl(proxyUrl, alsOverride != null);
  if (!dispatcher) {
    return nextOptions;
  }

  return {
    ...nextOptions,
    dispatcher,
  };
}

export function withExplicitProxyRequestInit(
  proxyUrl: string | null | undefined,
  options?: UndiciRequestInit,
  skipCache = false,
): UndiciRequestInit {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return options ?? {};

  const dispatcher = getDispatcherByProxyUrl(normalized, skipCache);
  if (!dispatcher) return options ?? {};

  return {
    ...(options || {}),
    dispatcher,
  };
}

export function resolveProxyUrlForSite(site: SiteProxyConfigLike | null | undefined): string | null {
  return normalizeSiteProxyUrl(site?.proxyUrl);
}

export function withSiteRecordProxyRequestInit(
  site: SiteProxyConfigLike | null | undefined,
  options?: UndiciRequestInit,
  accountProxyUrl?: string | null,
): UndiciRequestInit {
  const nextOptions: UndiciRequestInit = {
    ...(options || {}),
  };
  const profile = parseSiteProtocolProfile(site?.protocolProfile);
  const effectiveCustomHeaders = profile.requireCodexClient
    ? stripCodexClientFingerprintHeaders(site?.customHeaders)
    : site?.customHeaders;
  const mergedHeaders = mergeHeadersWithSiteCustomHeaders(effectiveCustomHeaders, options?.headers, {
    priority: resolveSiteCustomHeadersMergePriority(site),
  });
  if (mergedHeaders) {
    nextOptions.headers = mergedHeaders;
  }
  const accountNormalized = normalizeSiteProxyUrl(accountProxyUrl) ?? accountProxyOverride.getStore();
  const siteProxyUrl = resolveProxyUrlForSite(site);
  const proxyUrl = accountNormalized || siteProxyUrl;
  const isAccountOverride = !!accountNormalized && accountNormalized !== siteProxyUrl;
  return withExplicitProxyRequestInit(proxyUrl, nextOptions, isAccountOverride);
}

export function resolveChannelProxyUrl(
  site: SiteProxyConfigLike | null | undefined,
  accountExtraConfig?: string | null,
): string | null {
  if (accountExtraConfig) {
    const normalized = normalizeSiteProxyUrl(resolveProxyUrlFromExtraConfig(accountExtraConfig));
    if (normalized) return normalized;
  }
  return resolveProxyUrlForSite(site);
}
