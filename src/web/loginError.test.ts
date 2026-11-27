import { describe, expect, it } from 'vitest';
import { resolveLoginErrorMessage } from './loginError.js';

describe('resolveLoginErrorMessage', () => {
  it('returns IP allowlist hint when backend rejects by IP', () => {
    expect(resolveLoginErrorMessage(403, 'IP not allowed')).toBe('当前 IP 不在管理白名单中');
  });

  it('returns invalid token message for auth failures', () => {
    expect(resolveLoginErrorMessage(403, 'Invalid token')).toBe('登录令牌无效');
    expect(resolveLoginErrorMessage(401, 'Missing Authorization header')).toBe('登录令牌无效');
  });

  it('returns server error message for 5xx', () => {
    expect(resolveLoginErrorMessage(500, 'internal error')).toBe('服务端异常，请稍后重试');
  });

  it('explains the login throttle instead of blaming the service', () => {
    const message = resolveLoginErrorMessage(429, 'Too many failed authentication attempts');
    expect(message).toBe('登录尝试过于频繁，请稍后重试（服务本身正常）');
    expect(message).not.toContain('检查服务状态');
  });
});
