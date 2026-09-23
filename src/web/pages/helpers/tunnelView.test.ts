import { describe, expect, it } from 'vitest';
import { isTunnelClientView } from './tunnelView.js';

describe('isTunnelClientView', () => {
  const savedWindow = globalThis.window;

  function withHost(hostname: string, fn: () => void) {
    const win = {
      location: { hostname, host: `${hostname}` },
    } as unknown as Window & typeof globalThis;
    Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: savedWindow, configurable: true });
    }
  }

  it('treats a shell without window.location as local', () => {
    withHost(undefined as unknown as string, () => expect(isTunnelClientView()).toBe(false));
  });

  it('treats localhost / loopback as local', () => {
    for (const h of ['localhost', '127.0.0.1', '::1']) {
      withHost(h, () => expect(isTunnelClientView(), h).toBe(false));
    }
  });

  it('treats private IPv4 literals as local', () => {
    for (const h of ['10.1.2.3', '192.168.1.5', '172.16.0.1', '172.31.255.254']) {
      withHost(h, () => expect(isTunnelClientView(), h).toBe(false));
    }
  });

  it('treats public IPv4 literals as tunnel view', () => {
    for (const h of ['8.8.8.8', '114.114.114.114', '172.32.0.1', '192.169.0.1']) {
      withHost(h, () => expect(isTunnelClientView(), h).toBe(true));
    }
  });

  it('treats any hostname (quick/named tunnel, custom domain) as tunnel view', () => {
    for (const h of [
      'province-showed-brake-gossip.trycloudflare.com',
      'rq4gbtu.abc-tunnel.us',
      'origin.wyf9661.dpdns.org',
      'wyf9661.cc.cd',
      'my-console.example.com',
    ]) {
      withHost(h, () => expect(isTunnelClientView(), h).toBe(true));
    }
  });
});
