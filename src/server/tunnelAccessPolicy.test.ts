import { describe, expect, it } from 'vitest';
import { isTunnelAdminRequest, rejectTunnelAdminAction } from './tunnelAccessPolicy.js';

function fakeRequest(headers: Record<string, string>): any {
  return { headers };
}

function fakeReply(): { reply: any; sent: { code?: number; body?: any } } {
  const sent: { code?: number; body?: any } = {};
  const reply = {
    code(value: number) {
      sent.code = value;
      return reply;
    },
    send(body: any) {
      sent.body = body;
      return reply;
    },
  };
  return { reply, sent };
}

describe('tunnelAccessPolicy', () => {
  it('treats Cloudflare-tunnelled requests as tunnel admin requests', () => {
    expect(isTunnelAdminRequest(fakeRequest({ 'cf-ray': '8a1b2c3d4e5f6789-SJC' }))).toBe(true);
    expect(isTunnelAdminRequest(fakeRequest({ 'cf-connecting-ip': '203.0.113.9' }))).toBe(true);
    expect(isTunnelAdminRequest(fakeRequest({ host: 'province-showed-brake-gossip.trycloudflare.com' }))).toBe(true);
    expect(isTunnelAdminRequest(fakeRequest({ host: 'rq4gbtu.abc-tunnel.us' }))).toBe(true);
  });

  it('treats local console requests as local', () => {
    expect(isTunnelAdminRequest(fakeRequest({ host: '127.0.0.1:4000' }))).toBe(false);
    expect(isTunnelAdminRequest(fakeRequest({ host: 'localhost:4000' }))).toBe(false);
    expect(isTunnelAdminRequest(fakeRequest({ host: '192.168.1.20:4000' }))).toBe(false);
  });

  it('sends 403 for tunnel requests and reports that it handled the response', () => {
    const { reply, sent } = fakeReply();
    expect(rejectTunnelAdminAction(fakeRequest({ 'cf-ray': 'x' }), reply, '恢复出厂设置')).toBe(true);
    expect(sent.code).toBe(403);
    expect(String(sent.body.message)).toContain('通过公网隧道时不允许恢复出厂设置');
  });

  it('passes local requests through untouched', () => {
    const { reply, sent } = fakeReply();
    expect(rejectTunnelAdminAction(fakeRequest({ host: '127.0.0.1:4000' }), reply, '恢复出厂设置')).toBe(false);
    expect(sent.code).toBeUndefined();
  });
});
