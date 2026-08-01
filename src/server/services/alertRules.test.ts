import { describe, expect, it } from 'vitest';
import { appendSessionTokenRebindHint, isCloudflareChallenge, isTokenExpiredError } from './alertRules.js';

describe('alertRules', () => {
  it('detects cloudflare challenge messages', () => {
    expect(isCloudflareChallenge('Cloudflare challenge detected')).toBe(true);
    expect(isCloudflareChallenge('cf challenge required')).toBe(true);
    expect(isCloudflareChallenge('invalid token')).toBe(false);
  });

  it('detects token expiration by status or message', () => {
    // Explicit credential-invalid/expired language → true (same for 401 and non-401)
    expect(isTokenExpiredError({ status: 401, message: 'invalid token' })).toBe(true);
    expect(isTokenExpiredError({ status: 401, message: 'token expired' })).toBe(true);
    expect(isTokenExpiredError({ status: 401, message: 'invalid access token' })).toBe(true);
    expect(isTokenExpiredError({ status: 403, message: 'Forbidden' })).toBe(false);
    expect(isTokenExpiredError({ message: 'jwt expired' })).toBe(true);
    expect(isTokenExpiredError({ message: 'token invalid' })).toBe(true);
    expect(isTokenExpiredError({ message: 'invalid access token' })).toBe(true);
    expect(isTokenExpiredError({ message: 'Token 无效' })).toBe(true);
    expect(isTokenExpiredError({ message: '令牌已失效' })).toBe(true);
    expect(isTokenExpiredError({ message: '访问令牌无效' })).toBe(true);
    expect(isTokenExpiredError({ message: '无权进行此操作，未登录且未提供 access token' })).toBe(false);
    expect(isTokenExpiredError({ status: 500, message: 'upstream error' })).toBe(false);

    // Gateway-default 401 wording / missing-credential messages are NOT token
    // expiry: WAF blocks, rate-limit shields and header loss also produce them.
    expect(isTokenExpiredError({ status: 401, message: 'Unauthorized' })).toBe(false);
    expect(isTokenExpiredError({ status: 401, message: 'HTTP 401: access token required' })).toBe(false);
    expect(isTokenExpiredError({ status: 401, message: 'invalid request' })).toBe(false);
    expect(isTokenExpiredError({ status: 401, message: 'auth required' })).toBe(false);

    // Bare 401 without token language → false (transient / missing header)
    expect(isTokenExpiredError({ status: 401, message: '' })).toBe(false);
    expect(isTokenExpiredError({ status: 401 })).toBe(false);

    // 401 with HTML/WAF content → false (proxy/network issue, not token expiry)
    expect(isTokenExpiredError({ status: 401, message: '<html><body>nginx 401</body></html>' })).toBe(false);
    expect(isTokenExpiredError({ status: 401, message: '<!DOCTYPE html><html>Cloudflare</html>' })).toBe(false);
    expect(isTokenExpiredError({ status: 401, message: 'HTTP 401' })).toBe(false);
  });

  it('does not treat endpoint dispatch denial as token expiration', () => {
    expect(isTokenExpiredError({
      status: 403,
      message: 'This group does not allow /v1/messages dispatch',
    })).toBe(false);
    expect(isTokenExpiredError({
      status: 403,
      message: 'dispatch denied for /v1/responses',
    })).toBe(false);
    expect(isTokenExpiredError({
      message: 'unauthorized',
    })).toBe(false);
  });

  it('appends rebind hint for invalid access token messages', () => {
    expect(appendSessionTokenRebindHint('无权进行此操作，access token 无效'))
      .toContain('请在中转站重新生成系统访问令牌后重新绑定账号');
    expect(appendSessionTokenRebindHint('invalid access token'))
      .toContain('请在中转站重新生成系统访问令牌后重新绑定账号');
  });

  it('does not append rebind hint for unrelated messages', () => {
    expect(appendSessionTokenRebindHint('network timeout')).toBe('network timeout');
  });
});
