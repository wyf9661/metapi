import { describe, expect, it } from 'vitest';
import {
  isTunnelApiPath,
  isTunnelDashboardPath,
  isLikelyTunnelRequest,
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
