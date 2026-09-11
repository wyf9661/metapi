import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCloudflaredDownloadUrl,
  isTunnelApiPath,
  isTunnelDashboardPath,
  isLikelyTunnelRequest,
  resolveCloudflaredDownloadProxyUrl,
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
