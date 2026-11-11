import { describe, expect, it } from 'vitest';
import {
  isMissingCheckinEndpointMessage,
  rememberCheckinFailureMessage,
} from './newApiPure.js';

describe('isMissingCheckinEndpointMessage', () => {
  it('recognizes the /checkin router 404 noise', () => {
    expect(isMissingCheckinEndpointMessage('Invalid URL (POST /api/user/checkin)')).toBe(true);
    expect(isMissingCheckinEndpointMessage('HTTP 404: {"error":{"message":"Invalid URL (POST /api/user/checkin)"}}')).toBe(true);
  });

  it('recognizes the legacy /sign_in router 404 noise too', () => {
    expect(isMissingCheckinEndpointMessage('Invalid URL (POST /api/user/sign_in)')).toBe(true);
    expect(isMissingCheckinEndpointMessage('HTTP 404: {"error":{"message":"Invalid URL (POST /api/user/sign_in)"}}')).toBe(true);
  });

  it('does not swallow real auth or business errors', () => {
    expect(isMissingCheckinEndpointMessage('HTTP 401: invalid access token')).toBe(false);
    expect(isMissingCheckinEndpointMessage('无权进行此操作，未登录且未提供 access token')).toBe(false);
    expect(isMissingCheckinEndpointMessage('今天已经签到过啦')).toBe(false);
  });
});

describe('rememberCheckinFailureMessage', () => {
  it('never lets missing-endpoint noise override a real failure message', () => {
    const auth = 'HTTP 401: invalid access token';
    const noise = 'Invalid URL (POST /api/user/sign_in)';
    expect(rememberCheckinFailureMessage(auth, noise)).toBe(auth);
  });

  it('still records noise when nothing better exists, and lets real errors replace it', () => {
    const noise = 'Invalid URL (POST /api/user/sign_in)';
    expect(rememberCheckinFailureMessage(undefined, noise)).toBe(noise);
    expect(rememberCheckinFailureMessage(noise, 'HTTP 401: invalid access token')).toBe('HTTP 401: invalid access token');
  });

  it('keeps already-checked-in messages authoritative in both directions', () => {
    const already = '今天已经签到过啦';
    expect(rememberCheckinFailureMessage(already, 'HTTP 401: invalid access token')).toBe(already);
    expect(rememberCheckinFailureMessage('HTTP 401: invalid access token', already)).toBe(already);
  });
});
