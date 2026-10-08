import Fastify, { type FastifyInstance } from 'fastify';
import { Headers, Response } from 'undici';
import { promises as dns } from 'node:dns';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: fetchMock,
}));

type DbModule = typeof import('../../db/index.js');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>';

describe('site favicon proxy routing', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  const oldDataDir = process.env.DATA_DIR;
  // The icon fetch falls back to the SYSTEM proxy when a site has none, so a
  // developer shell that exports `https_proxy` (for curl/git) would otherwise
  // decide which branch these cases exercise. Clear every spelling for the whole
  // file and restore it afterwards.
  const PROXY_ENV_NAMES = [
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
  ] as const;
  const originalProxyEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const name of PROXY_ENV_NAMES) originalProxyEnv.set(name, process.env[name]);
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-favicon-routing-'));
    await import('../../db/migrate.js');
    ({ db, schema } = await import('../../db/index.js'));
    app = Fastify();
    await app.register((await import('./sites.js')).sitesRoutes);
  });

  beforeEach(async () => {
    for (const name of PROXY_ENV_NAMES) delete process.env[name];
    vi.restoreAllMocks();
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await db.delete(schema.sites).run();
    (await import('../../services/iconProxyService.js')).__resetIconCacheForTests();
    (await import('../../services/siteProxy.js')).invalidateSiteProxyCache();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(svg, {
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
    (await import('../../services/siteProxy.js')).stopDispatcherCacheSweep();
    for (const name of PROXY_ENV_NAMES) {
      const original = originalProxyEnv.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    if (oldDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
  });

  it('downloads a configured site icon through that site proxy', async () => {
    await db.insert(schema.sites).values({
      name: 'proxied-site',
      url: 'https://site.example.com',
      platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/site-favicon?url=https%3A%2F%2Fsite.example.com',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(svg);
    const { ProxyAgent } = await import('undici');
    // Page first (the mock answers every URL with an image, so the document is
    // not HTML and declares nothing), then the conventional /favicon.ico.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('keeps response cookies across same-origin icon redirects through the proxy', async () => {
    await db.insert(schema.sites).values({
      name: 'redirect-site',
      url: 'https://redirect.example.com',
      platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === 'https://redirect.example.com/favicon.ico') {
        return new Response('', {
          status: 307,
          headers: {
            location: '/favicon.ico?ready=1',
            'set-cookie': 'cdn_sec_tc=icon-challenge; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (String(url) === 'https://redirect.example.com/favicon.ico?ready=1'
        && new Headers(init.headers).get('cookie') === 'cdn_sec_tc=icon-challenge') {
        return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
      }
      return new Response('', { status: 404 });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/site-favicon?url=https%3A%2F%2Fredirect.example.com',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(svg);
    // page (404) -> /favicon.ico (307) -> /favicon.ico?ready=1 (200)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const { ProxyAgent } = await import('undici');
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.dispatcher).toBeInstanceOf(ProxyAgent);
      expect(init.redirect).toBe('manual');
    }
  });

  it('keeps the site proxy on CDN redirects without forwarding origin cookies', async () => {
    await db.insert(schema.sites).values({
      name: 'cdn-site', url: 'https://site.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
      customHeaders: JSON.stringify({ Authorization: 'Bearer private-account-token' }),
    }).run();
    fetchMock.mockImplementation(async (url) => String(url).includes('cdn.example.com')
      ? new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
      : new Response('', {
        status: 302,
        headers: { location: 'https://cdn.example.com/logo.svg', 'set-cookie': 'session=origin-only; Path=/' },
      }));

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(200);
    // page (302 -> cdn) then /favicon.ico (302 -> cdn); the page hop returns an
    // image, so nothing is parsed out of it.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const { ProxyAgent } = await import('undici');
    const [, cdnInit] = fetchMock.mock.calls[1];
    expect(cdnInit.dispatcher).toBeInstanceOf(ProxyAgent);
    expect(new Headers(cdnInit.headers).get('cookie')).toBeNull();
    expect(new Headers(cdnInit.headers).get('authorization')).toBeNull();
  });

  it('uses the site proxy for the homepage and its declared CDN icon', async () => {
    await db.insert(schema.sites).values({
      name: 'html-site', url: 'https://site.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === 'https://site.example.com/') {
        return new Response('<link rel="icon" href="https://cdn.example.com/logo.svg">', {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (String(url) === 'https://cdn.example.com/logo.svg') {
        return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
      }
      return new Response('', { status: 404 });
    });

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-favicon-source']).toBe('https://cdn.example.com/logo.svg');
    const { ProxyAgent } = await import('undici');
    // Exactly two requests: the document, then the icon it declares. No static
    // path is guessed first, and none is guessed afterwards either.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) expect(init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('never retries directly after the configured proxy fails', async () => {
    await db.insert(schema.sites).values({
      name: 'offline-proxy', url: 'https://site.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    fetchMock.mockRejectedValue(new Error('proxy connection refused'));

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(404);
    // page + /favicon.ico + the four non-standard compatibility paths
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const { ProxyAgent } = await import('undici');
    for (const [, init] of fetchMock.mock.calls) expect(init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('fetches directly when the configured site has no proxy', async () => {
    await db.insert(schema.sites).values({
      name: 'direct-site', url: 'https://site.example.com', platform: 'new-api',
    }).run();
    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeUndefined();
  });

  it('falls back to the system proxy when a site has no proxy of its own', async () => {
    await db.insert(schema.sites).values({
      name: 'sys-proxy-site', url: 'https://sysproxy.example.com', platform: 'new-api',
    }).run();
    // Without this the forced-direct global dispatcher (siteProxy) wins and an
    // upstream only reachable through the host proxy never answers: the lookup
    // then degrades to a guessed path instead of the declared icon.
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    try {
      const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsysproxy.example.com');
      expect(response.statusCode).toBe(200);
      expect(fetchMock.mock.calls[0][1].dispatcher).toBeDefined();
    } finally {
      delete process.env.HTTPS_PROXY;
    }
  });

  it('falls back to the system proxy when a site has no proxy of its own', async () => {
    await db.insert(schema.sites).values({
      name: 'sys-proxy-site', url: 'https://sysproxy.example.com', platform: 'new-api',
    }).run();
    // Without this the forced-direct global dispatcher (siteProxy) wins and an
    // upstream only reachable through the host proxy never answers: the lookup
    // then degrades to a guessed path instead of the declared icon.
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    try {
      const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsysproxy.example.com');
      expect(response.statusCode).toBe(200);
      expect(fetchMock.mock.calls[0][1].dispatcher).toBeDefined();
    } finally {
      delete process.env.HTTPS_PROXY;
    }
  });

  it('does not flap on a host whose DNS returns a loopback address alongside a public one', async () => {
    // Observed live: api.astrdark.cyou resolved to [`::1`, `221.228.32.13`];
    // resolving only the `::1` makes the icon guard skip the declared icons and
    // the lookup degrades to a guessed path while the fetch itself succeeds.
    await db.insert(schema.sites).values({
      name: 'mixed-address-site', url: 'https://lookback.example.com', platform: 'new-api',
    }).run();
    // Override the global mock for this test: the site's host resolves to
    // both a loopback and a public address.
    (dns.lookup as any).mockImplementationOnce(async (host: string, opts?: any) => {
      if (host === 'lookback.example.com' && opts?.all) {
        return [
          { address: '::1', family: 6 },
          { address: '93.184.216.34', family: 4 },
        ];
      }
      return [{ address: '93.184.216.34', family: 4 }];
    });
    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Flookback.example.com');
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-favicon-source']).not.toBeUndefined();
  });

  it('does not reuse a cached direct miss after the site proxy changes', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'changed-proxy', url: 'https://site.example.com', platform: 'new-api',
    }).returning().get();
    fetchMock.mockImplementation(async (_url, init) => init.dispatcher
      ? new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
      : new Response('', { status: 404 }));
    const requestUrl = '/api/site-favicon?url=https%3A%2F%2Fsite.example.com';
    expect((await app.inject(requestUrl)).statusCode).toBe(404);
    await db.update(schema.sites).set({ proxyUrl: 'http://127.0.0.1:9876' })
      .where(eq(schema.sites.id, site.id)).run();
    const response = await app.inject(requestUrl);
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-favicon-cache']).toBe('MISS');
    expect((await app.inject(requestUrl)).headers['x-favicon-cache']).toBe('HIT');
    // 6 misses while direct, then page + .ico through the proxy
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('rejects an icon download that exceeds the byte cap while streaming', async () => {
    await db.insert(schema.sites).values({
      name: 'huge-icon', url: 'https://huge.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    // No content-length: the cap must be enforced while reading the stream,
    // not from headers. 700KB crosses the 512KB MAX_ICON_BYTES cap.
    const huge = Buffer.alloc(700 * 1024, 0x61);
    fetchMock.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(huge));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'image/svg+xml' } }));

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fhuge.example.com');
    expect(response.statusCode).toBe(404);
  });

  it('rejects a private redirect target even for a configured public site', async () => {
    await db.insert(schema.sites).values({
      name: 'redirect-guard', url: 'https://site.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    fetchMock.mockImplementation(async () => new Response('', {
      status: 302, headers: { location: 'https://127.0.0.1/private-icon' },
    }));
    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(404);
    expect(fetchMock.mock.calls.every(([url]) => new URL(url).hostname === 'site.example.com')).toBe(true);
  });

  it('rejects unconfigured private origins without making any request', async () => {
    const response = await app.inject('/api/site-favicon?url=http%3A%2F%2F127.0.0.1%3A9');
    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the configured proxy when a site URL contains a path', async () => {
    await db.insert(schema.sites).values({
      name: 'path-site', url: 'https://site.example.com/provider/api', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fsite.example.com');
    expect(response.statusCode).toBe(200);
    const { ProxyAgent } = await import('undici');
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('selects the requested site proxy when multiple sites share an origin', async () => {
    await db.insert(schema.sites).values({
      name: 'root-direct', url: 'https://site.example.com', platform: 'openai',
    }).run();
    const proxied = await db.insert(schema.sites).values({
      name: 'path-proxied', url: 'https://site.example.com/provider', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).returning().get();
    const response = await app.inject(`/api/site-favicon?url=https%3A%2F%2Fsite.example.com&siteId=${proxied.id}`);
    expect(response.statusCode).toBe(200);
    const { ProxyAgent } = await import('undici');
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('does not lend a site proxy to a different origin', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'known-site', url: 'https://site.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).returning().get();
    const response = await app.inject(`/api/site-favicon?url=https%3A%2F%2Fother.example.com&siteId=${site.id}`);
    expect(response.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('prefers the icon the page declares over a conventional /favicon.ico', async () => {
    await db.insert(schema.sites).values({
      name: 'declared-site', url: 'https://declared.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === 'https://declared.example.com/') {
        return new Response(
          '<link rel="icon" sizes="16x16" href="/small.png">'
          + '<link rel="icon" type="image/svg+xml" sizes="any" href="/brand.svg">',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      // A perfectly usable legacy icon that must NOT win over the declared SVG.
      if (String(url) === 'https://declared.example.com/favicon.ico') {
        return new Response('ico', { headers: { 'content-type': 'image/x-icon' } });
      }
      if (String(url) === 'https://declared.example.com/brand.svg') {
        return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
      }
      return new Response('', { status: 404 });
    });

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fdeclared.example.com');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(svg);
    expect(response.headers['x-favicon-source']).toBe('https://declared.example.com/brand.svg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses an inline declared icon instead of probing paths', async () => {
    await db.insert(schema.sites).values({
      name: 'inline-site', url: 'https://inline.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    const inline = 'data:image/png;base64,' + Buffer.from('inline-bytes').toString('base64');
    fetchMock.mockImplementation(async (url) => String(url) === 'https://inline.example.com/'
      ? new Response(`<link rel="icon" href="${inline}">`, {
        headers: { 'content-type': 'text/html' },
      })
      : new Response('', { status: 404 }));

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Finline.example.com');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('inline-bytes');
    expect(response.headers['x-favicon-source']).toBe('data:uri');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('probes non-standard logo paths only after the page and /favicon.ico fail', async () => {
    await db.insert(schema.sites).values({
      name: 'legacy-site', url: 'https://legacy.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    fetchMock.mockImplementation(async (url) => String(url) === 'https://legacy.example.com/favicon.png'
      ? new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
      : new Response('', { status: 404 }));

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Flegacy.example.com');
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-favicon-source']).toBe('/favicon.png');
    // page, /favicon.ico, then the first compatibility candidate
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('serves a declared oversized inline icon instead of an undeclared /favicon.ico', async () => {
    await db.insert(schema.sites).values({
      name: 'huge-inline-site', url: 'https://huge.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    // 200KB of base64 is a plausible-looking upstream mistake (observed live).
    const bytes = Buffer.alloc(200 * 1024, 7);
    const huge = 'data:image/jpeg;base64,' + bytes.toString('base64');
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === 'https://huge.example.com/') {
        return new Response(`<link rel="icon" href="${huge}">`, {
          headers: { 'content-type': 'text/html' },
        });
      }
      // A legacy icon at the conventional path that must NOT outrank what the
      // page actually declares — the browser shows the declared one too.
      if (String(url) === 'https://huge.example.com/favicon.ico') {
        return new Response('ico', { headers: { 'content-type': 'image/x-icon' } });
      }
      return new Response('', { status: 404 });
    });

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fhuge.example.com');
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-favicon-source']).toBe('data:uri');
    expect(response.rawPayload.equals(bytes)).toBe(true);
    // page only: a declared icon never falls through to path guessing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The deferral must not lengthen the browser cache: one hour, like any
    // other icon this proxy serves.
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('lets a declared URL icon win over an oversized inline one', async () => {
    await db.insert(schema.sites).values({
      name: 'inline-only-site', url: 'https://inline-only.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    const huge = 'data:image/jpeg;base64,' + Buffer.alloc(120 * 1024, 9).toString('base64');
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === 'https://inline-only.example.com/') {
        return new Response(
          `<link rel="icon" href="${huge}"><link rel="icon" type="image/svg+xml" href="/brand.svg">`,
          { headers: { 'content-type': 'text/html' } },
        );
      }
      if (String(url) === 'https://inline-only.example.com/brand.svg') {
        return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
      }
      return new Response('', { status: 404 });
    });

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Finline-only.example.com');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(svg);
    expect(response.headers['x-favicon-source']).toBe('https://inline-only.example.com/brand.svg');
    // page + the declared URL icon; the deferred blob is never decoded into a
    // response while a real URL icon is available.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps how large a deferred inline icon may be', async () => {
    await db.insert(schema.sites).values({
      name: 'absurd-inline-site', url: 'https://absurd.example.com', platform: 'new-api',
      proxyUrl: 'http://127.0.0.1:9876',
    }).run();
    // Above the 512KB ceiling: a page that inlines a whole screenshot as its icon.
    const absurd = 'data:image/png;base64,' + Buffer.alloc(600 * 1024, 3).toString('base64');
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === 'https://absurd.example.com/') {
        return new Response(`<link rel="icon" href="${absurd}">`, {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (String(url) === 'https://absurd.example.com/favicon.ico') {
        return new Response('ico', { headers: { 'content-type': 'image/x-icon' } });
      }
      return new Response('', { status: 404 });
    });

    const response = await app.inject('/api/site-favicon?url=https%3A%2F%2Fabsurd.example.com');
    expect(response.statusCode).toBe(200);
    // Over the ceiling the blob is refused outright and the lookup keeps going
    // instead of streaming a screenshot to every client.
    expect(response.body).toBe('ico');
    expect(response.headers['x-favicon-source']).toBe('https://absurd.example.com/favicon.ico');
  });

  it('collapses concurrent cold requests for one site into a single upstream resolution', async () => {
    await db.insert(schema.sites).values({
      name: 'burst-site', url: 'https://site.example.com', platform: 'new-api',
    }).run();
    const requestUrl = '/api/site-favicon?url=https%3A%2F%2Fsite.example.com';
    // The usage-log page renders one badge per row: ten rows of the same site
    // used to mean ten page fetches (measured ~6-8s wall before this).
    const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject(requestUrl)));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    // One page read + one /favicon.ico hit for the whole burst — not eight.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers from the on-disk cache after the in-memory cache is dropped (restart)', async () => {
    await db.insert(schema.sites).values({
      name: 'restart-site', url: 'https://site.example.com', platform: 'new-api',
    }).run();
    const requestUrl = '/api/site-favicon?url=https%3A%2F%2Fsite.example.com';
    const first = await app.inject(requestUrl);
    expect(first.headers['x-favicon-cache']).toBe('MISS');
    const callsAfterFirst = fetchMock.mock.calls.length;

    // Simulate a process restart: memory gone, DATA_DIR (and its icon-cache) kept.
    (await import('../../services/iconProxyService.js')).__clearIconMemoryCacheForTests();

    const second = await app.inject(requestUrl);
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-favicon-cache']).toBe('HIT');
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
    // No upstream traffic at all — the disk layer answered.
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
