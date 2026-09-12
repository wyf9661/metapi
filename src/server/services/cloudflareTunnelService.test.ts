import { afterEach, describe, expect, it, vi } from 'vitest';

const { undiciFetchMock } = vi.hoisted(() => ({ undiciFetchMock: vi.fn() }));

// cloudflareTunnelService imports `fetch` from undici directly, so stubbing
// globalThis.fetch would not intercept it — and an unmocked call would hit the
// real relay. Mock the module instead.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: undiciFetchMock };
});

// Belt and braces: keep this suite away from the real tunnel relay even if a
// mock regresses.
process.env.TUNNEL_WORKER_URL = 'http://127.0.0.1:9';
import {
  buildCloudflaredDownloadUrl,
  isTunnelApiPath,
  isTunnelDashboardPath,
  isLikelyTunnelRequest,
  registerStableTunnelMapping,
  resolveCloudflaredDownloadProxyUrl,
  waitForPublicUrlHealthy,
} from './cloudflareTunnelService.js';

describe('cloudflare tunnel access helpers', () => {
  it('treats /v1 paths as API', () => {
    expect(isTunnelApiPath('/v1/models')).toBe(true);
    expect(isTunnelApiPath('/v1/chat/completions')).toBe(true);
    expect(isTunnelApiPath('/api/settings/runtime')).toBe(false);
  });

  it('treats SPA and management APIs as dashboard surface', () => {
    expect(isTunnelDashboardPath('/')).toBe(true);
    expect(isTunnelDashboardPath('/settings')).toBe(true);
    expect(isTunnelDashboardPath('/api/settings/runtime')).toBe(true);
    expect(isTunnelDashboardPath('/logo.svg')).toBe(true);
    expect(isTunnelDashboardPath('/favicon.png')).toBe(true);
    expect(isTunnelDashboardPath('/v1/models')).toBe(false);
  });

  it('detects cloudflare tunnel requests by headers/host', () => {
    expect(isLikelyTunnelRequest({
      headers: { 'cf-ray': 'abc' },
    })).toBe(true);
    expect(isLikelyTunnelRequest({
      headers: { host: 'foo.trycloudflare.com' },
    })).toBe(true);
    expect(isLikelyTunnelRequest({
      headers: { host: '127.0.0.1:5000' },
    })).toBe(false);
  });
});

describe('cloudflared download helpers', () => {
  const originalDownloadUrl = process.env.CLOUDFLARED_DOWNLOAD_URL;

  afterEach(() => {
    if (originalDownloadUrl === undefined) delete process.env.CLOUDFLARED_DOWNLOAD_URL;
    else process.env.CLOUDFLARED_DOWNLOAD_URL = originalDownloadUrl;
  });

  it('builds the default GitHub release asset URL', () => {
    delete process.env.CLOUDFLARED_DOWNLOAD_URL;
    expect(buildCloudflaredDownloadUrl('cloudflared-linux-amd64')).toBe(
      'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
    );
  });

  it('honors CLOUDFLARED_DOWNLOAD_URL overrides and trims trailing slashes', () => {
    process.env.CLOUDFLARED_DOWNLOAD_URL = 'https://mirror.example.com/cloudflared///';
    expect(buildCloudflaredDownloadUrl('cloudflared-linux-amd64')).toBe(
      'https://mirror.example.com/cloudflared/cloudflared-linux-amd64',
    );
  });

  it('resolves the download proxy from standard proxy env vars', () => {
    expect(resolveCloudflaredDownloadProxyUrl({
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:8080',
    } as NodeJS.ProcessEnv)).toBe('http://127.0.0.1:7897');
    expect(resolveCloudflaredDownloadProxyUrl({
      http_proxy: 'socks5://127.0.0.1:1080',
    } as NodeJS.ProcessEnv)).toBe('socks5://127.0.0.1:1080');
    expect(resolveCloudflaredDownloadProxyUrl({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveCloudflaredDownloadProxyUrl({ HTTPS_PROXY: 'not a url' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('stable tunnel mapping registration', () => {
  afterEach(() => {
    vi.useRealTimers();
    undiciFetchMock.mockReset();
  });

  it('retries registration after transient network failures', async () => {
    vi.useFakeTimers();
    let calls = 0;
    undiciFetchMock.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error('fetch failed');
      return { ok: true, status: 200 } as unknown as Response;
    });
    const promise = registerStableTunnelMapping('q4gbtu', 'https://demo.trycloudflare.com');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBeUndefined();
    expect(undiciFetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting registration retries', async () => {
    vi.useFakeTimers();
    undiciFetchMock.mockImplementation(async () => {
      throw new Error('fetch failed');
    });
    const promise = registerStableTunnelMapping('q4gbtu', 'https://demo.trycloudflare.com');
    const rejection = expect(promise).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(undiciFetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('stable url health check', () => {
  afterEach(() => {
    vi.useRealTimers();
    undiciFetchMock.mockReset();
  });

  it('rejects 5xx responses such as the 530 origin-dns-error page', async () => {
    vi.useFakeTimers();
    undiciFetchMock.mockImplementation(async () => ({ status: 530, body: null }) as unknown as Response);
    const promise = waitForPublicUrlHealthy('https://r-demo.abc-tunnel.us', 5_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(promise).resolves.toBe(false);
  });

  it('accepts an auth-gated app response', async () => {
    undiciFetchMock.mockImplementation(async () => ({ status: 401, body: null }) as unknown as Response);
    await expect(waitForPublicUrlHealthy('https://r-demo.abc-tunnel.us', 5_000)).resolves.toBe(true);
  });
});
