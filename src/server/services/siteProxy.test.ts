import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Headers } from 'undici';

type DbModule = typeof import('../db/index.js');

describe('siteProxy', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-proxy-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    const { invalidateSiteProxyCache } = await import('./siteProxy.js');
    await db.delete(schema.accounts).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
    invalidateSiteProxyCache();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('resolves site-specific proxy url when configured', async () => {
    await db.run(sql`
      INSERT INTO sites (name, url, platform, proxy_url)
      VALUES ('proxy-site', 'https://proxy-site.example.com', 'new-api', 'socks5://127.0.0.1:1080')
    `);

    const { resolveSiteProxyUrlByRequestUrl } = await import('./siteProxy.js');
    expect(await resolveSiteProxyUrlByRequestUrl('https://proxy-site.example.com/v1/models'))
      .toBe('socks5://127.0.0.1:1080');
  });

  it('injects dispatcher when a site defines its own proxy url', async () => {
    await db.run(sql`
      INSERT INTO sites (name, url, platform, proxy_url)
      VALUES ('proxy-site', 'https://proxy-site.example.com', 'new-api', 'http://127.0.0.1:7890')
    `);

    const { withSiteProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = await withSiteProxyRequestInit('https://proxy-site.example.com/v1/chat/completions', {
      method: 'POST',
    });

    expect('dispatcher' in requestInit).toBe(true);
  });

  it('merges site custom headers by matched request url and keeps explicit headers authoritative', async () => {
    await db.insert(schema.sites).values({
      name: 'headers-site',
      url: 'https://headers-site.example.com',
      platform: 'new-api',
      customHeaders: JSON.stringify({
        'cf-access-client-id': 'site-client',
        authorization: 'Bearer site-default',
      }),
    }).run();

    const { withSiteProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = await withSiteProxyRequestInit('https://headers-site.example.com/v1/models', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer request-token',
        'X-Trace-Id': 'trace-1',
      },
    });
    const headers = new Headers(requestInit.headers);

    expect(headers.get('cf-access-client-id')).toBe('site-client');
    expect(headers.get('authorization')).toBe('Bearer request-token');
    expect(headers.get('x-trace-id')).toBe('trace-1');
  });

  it('lets site custom headers override request headers when the override flag is enabled', async () => {
    await db.insert(schema.sites).values({
      name: 'headers-override-site',
      url: 'https://headers-override-site.example.com',
      platform: 'new-api',
      customHeaders: JSON.stringify({
        Authorization: 'Bearer site-token',
        'User-Agent': 'site-agent',
      }),
      customHeadersOverrideRequestHeaders: true,
    }).run();

    const { withSiteProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = await withSiteProxyRequestInit('https://headers-override-site.example.com/v1/models', {
      method: 'GET',
      headers: {
        authorization: 'Bearer request-token',
        'user-agent': 'request-agent',
        'X-Trace-Id': 'trace-1',
      },
    });
    const headers = new Headers(requestInit.headers);

    // With customHeadersOverrideRequestHeaders enabled, site custom headers win
    // over the outbound request headers (this is how an operator forces a
    // browser User-Agent to clear a Cloudflare/WAF 403). Non-conflicting
    // request headers are still preserved.
    expect(headers.get('authorization')).toBe('Bearer site-token');
    expect(headers.get('user-agent')).toBe('site-agent');
    expect(headers.get('x-trace-id')).toBe('trace-1');
  });

  it('keeps request headers authoritative when the override flag is disabled', async () => {
    await db.insert(schema.sites).values({
      name: 'headers-no-override-site',
      url: 'https://headers-no-override-site.example.com',
      platform: 'new-api',
      customHeaders: JSON.stringify({
        Authorization: 'Bearer site-token',
        'User-Agent': 'site-agent',
      }),
      customHeadersOverrideRequestHeaders: false,
    }).run();

    const { withSiteProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = await withSiteProxyRequestInit('https://headers-no-override-site.example.com/v1/models', {
      method: 'GET',
      headers: {
        authorization: 'Bearer request-token',
        'user-agent': 'request-agent',
        'X-Trace-Id': 'trace-1',
      },
    });
    const headers = new Headers(requestInit.headers);

    // Default behavior: request headers win over site custom headers.
    expect(headers.get('authorization')).toBe('Bearer request-token');
    expect(headers.get('user-agent')).toBe('request-agent');
    expect(headers.get('x-trace-id')).toBe('trace-1');
  });

  it('skips codex client custom headers for management APIs but keeps them on /v1 paths', async () => {
    await db.insert(schema.sites).values({
      name: 'codex-header-scope-site',
      url: 'https://codex-header-scope.example.com',
      platform: 'new-api',
      customHeaders: JSON.stringify({
        'User-Agent': 'codex_cli_rs/0.39.0',
        originator: 'codex_cli_rs',
        'X-Site-Token': 'keep-me',
      }),
    }).run();

    const { withSiteProxyRequestInit } = await import('./siteProxy.js');

    const manageInit = await withSiteProxyRequestInit('https://codex-header-scope.example.com/api/user/self', {
      method: 'GET',
      headers: {
        'user-agent': 'request-agent',
      },
    });
    const manageHeaders = new Headers(manageInit.headers);
    expect(manageHeaders.get('user-agent')).toBe('request-agent');
    expect(manageHeaders.get('originator')).toBeNull();
    expect(manageHeaders.get('x-site-token')).toBe('keep-me');

    const modelsInit = await withSiteProxyRequestInit('https://codex-header-scope.example.com/v1/models', {
      method: 'GET',
      headers: {
        'user-agent': 'request-agent',
      },
    });
    const modelHeaders = new Headers(modelsInit.headers);
    // Request headers win over site custom headers; non-conflicting site
    // headers (originator, X-Site-Token) are still added on /v1 paths.
    expect(modelHeaders.get('user-agent')).toBe('request-agent');
    expect(modelHeaders.get('originator')).toBe('codex_cli_rs');
    expect(modelHeaders.get('x-site-token')).toBe('keep-me');
  });

  it('strips codex fingerprint from site custom headers even when the override flag is enabled', async () => {
    // Codex safety: a codex-gated site (requireCodexClient) must never let a
    // stale site User-Agent/originator override the runtime-injected Codex
    // fingerprint, even with customHeadersOverrideRequestHeaders enabled. The
    // strip happens before the merge, so the site UA is dropped and only the
    // request UA survives here (the full Codex signature is rebuilt later at
    // the upstreamRequestBuilder layer).
    await db.insert(schema.sites).values({
      name: 'codex-override-safety-site',
      url: 'https://codex-override-safety.example.com',
      platform: 'new-api',
      protocolProfile: JSON.stringify({ requireCodexClient: true }),
      customHeaders: JSON.stringify({
        'User-Agent': 'stale-codex-ua/0.1.0',
        originator: 'stale_codex',
        'X-Site-Token': 'keep-me',
      }),
      customHeadersOverrideRequestHeaders: true,
    }).run();

    const { withSiteProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = await withSiteProxyRequestInit('https://codex-override-safety.example.com/v1/responses', {
      method: 'POST',
      headers: {
        'user-agent': 'request-agent',
      },
    });
    const headers = new Headers(requestInit.headers);

    // Site UA/originator were stripped before merge, so they cannot override.
    expect(headers.get('user-agent')).toBe('request-agent');
    expect(headers.get('originator')).toBeNull();
    // Non-fingerprint site headers are still applied.
    expect(headers.get('x-site-token')).toBe('keep-me');
  });

  it('merges site custom headers from site records even without cache lookup', async () => {
    const { withSiteRecordProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = withSiteRecordProxyRequestInit({
      proxyUrl: 'http://127.0.0.1:7890',
      customHeaders: JSON.stringify({
        'x-site-scope': 'site-level',
      }),
    }, {
      method: 'POST',
      headers: {
        'X-Request-Id': 'req-1',
      },
    });
    const headers = new Headers(requestInit.headers);

    expect(headers.get('x-site-scope')).toBe('site-level');
    expect(headers.get('x-request-id')).toBe('req-1');
    expect('dispatcher' in requestInit).toBe(true);
  });

  it('site record custom headers override request headers when the override flag is enabled', async () => {
    const { withSiteRecordProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = withSiteRecordProxyRequestInit({
      proxyUrl: null,
      customHeaders: JSON.stringify({
        Authorization: 'Bearer site-token',
        'User-Agent': 'site-agent',
      }),
      customHeadersOverrideRequestHeaders: true,
    }, {
      method: 'POST',
      headers: {
        authorization: 'Bearer request-token',
        'user-agent': 'request-agent',
      },
    });
    const headers = new Headers(requestInit.headers);

    // Override flag enabled: site custom headers win over request headers.
    expect(headers.get('authorization')).toBe('Bearer site-token');
    expect(headers.get('user-agent')).toBe('site-agent');
  });

  it('site record request headers stay authoritative when the override flag is disabled', async () => {
    const { withSiteRecordProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = withSiteRecordProxyRequestInit({
      proxyUrl: null,
      customHeaders: JSON.stringify({
        Authorization: 'Bearer site-token',
        'User-Agent': 'site-agent',
      }),
      customHeadersOverrideRequestHeaders: false,
    }, {
      method: 'POST',
      headers: {
        authorization: 'Bearer request-token',
        'user-agent': 'request-agent',
      },
    });
    const headers = new Headers(requestInit.headers);

    // Override flag disabled (default): request headers win.
    expect(headers.get('authorization')).toBe('Bearer request-token');
    expect(headers.get('user-agent')).toBe('request-agent');
  });

  it('merges parsed-object site custom headers from site records', async () => {
    const { withSiteRecordProxyRequestInit } = await import('./siteProxy.js');
    const requestInit = withSiteRecordProxyRequestInit({
      proxyUrl: 'http://127.0.0.1:7890',
      customHeaders: {
        'x-site-scope': 'site-level',
      },
    }, {
      method: 'POST',
      headers: {
        'X-Request-Id': 'req-1',
      },
    });
    const headers = new Headers(requestInit.headers);

    expect(headers.get('x-site-scope')).toBe('site-level');
    expect(headers.get('x-request-id')).toBe('req-1');
  });

  it('resolveChannelProxyUrl prefers account proxy over site proxy', async () => {
    const { resolveChannelProxyUrl } = await import('./siteProxy.js');

    const accountConfig = JSON.stringify({ proxyUrl: 'http://account-proxy:8080' });
    const siteWithProxy = {};

    expect(resolveChannelProxyUrl(siteWithProxy, accountConfig)).toBe('http://account-proxy:8080');
    expect(resolveChannelProxyUrl(siteWithProxy, null)).toBeNull();
    expect(resolveChannelProxyUrl(siteWithProxy, JSON.stringify({}))).toBeNull();
  });

  it('withSiteRecordProxyRequestInit uses account proxy when provided', async () => {
    const { withSiteRecordProxyRequestInit } = await import('./siteProxy.js');
    const result = withSiteRecordProxyRequestInit(
    {},
    { method: 'POST' },
    'http://account-proxy:8080',
    );
    expect('dispatcher' in result).toBe(true);
  });

  it('withSiteRecordProxyRequestInit ignores invalid account proxy', async () => {
    const { withSiteRecordProxyRequestInit } = await import('./siteProxy.js');
    const result = withSiteRecordProxyRequestInit(
    {},
    { method: 'POST' },
    'not-a-url',
    );
    expect('dispatcher' in result).toBe(false);
  });

  it('withAccountProxyOverride sets ALS context for nested proxy calls', async () => {
    const { withAccountProxyOverride, withSiteProxyRequestInit } = await import('./siteProxy.js');

    await db.insert(schema.sites).values({
      name: 'als-site',
      url: 'https://als-site.example.com',
      platform: 'new-api',
    }).run();

    const result = await withAccountProxyOverride(
      'http://account-als-proxy:9090',
      async () => {
        return withSiteProxyRequestInit('https://als-site.example.com/v1/models', {
          method: 'GET',
        });
      },
    );

    expect('dispatcher' in result).toBe(true);
  });

  it('withAccountProxyOverride skips ALS when proxy is null', async () => {
    const { withAccountProxyOverride, withSiteProxyRequestInit } = await import('./siteProxy.js');

    await db.insert(schema.sites).values({
      name: 'als-null-site',
      url: 'https://als-null-site.example.com',
      platform: 'new-api',
    }).run();

    const result = await withAccountProxyOverride(
      null,
      async () => {
        return withSiteProxyRequestInit('https://als-null-site.example.com/v1/models', {
          method: 'GET',
        });
      },
    );

    expect('dispatcher' in result).toBe(false);
  });
});
