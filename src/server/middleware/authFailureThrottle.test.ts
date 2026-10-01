import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthFailureThrottle } from './authFailureThrottle.js';

describe('createAuthFailureThrottle', () => {
  it('allows attempts up to the budget, then blocks the key', async () => {
    const throttle = createAuthFailureThrottle({ maxFailures: 3, windowMs: 60_000, blockMs: 60_000 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const verdict = await throttle.recordFailure('10.0.0.1');
      expect(verdict.blocked).toBe(false);
    }

    const blocked = await throttle.recordFailure('10.0.0.1');
    expect(blocked.blocked).toBe(true);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect((await throttle.peek('10.0.0.1')).blocked).toBe(true);
  });

  it('counts per key, so one noisy client cannot block another', async () => {
    const throttle = createAuthFailureThrottle({ maxFailures: 2, windowMs: 60_000, blockMs: 60_000 });

    await throttle.recordFailure('10.0.0.1');
    await throttle.recordFailure('10.0.0.1');
    expect((await throttle.peek('10.0.0.1')).blocked).toBe(true);

    // A different source is unaffected.
    expect((await throttle.peek('10.0.0.2')).blocked).toBe(false);
    expect((await throttle.recordFailure('10.0.0.2')).blocked).toBe(false);
  });

  it('clears the budget for a key after a valid credential', async () => {
    const throttle = createAuthFailureThrottle({ maxFailures: 3, windowMs: 60_000, blockMs: 60_000 });

    await throttle.recordFailure('10.0.0.1');
    await throttle.recordFailure('10.0.0.1');
    expect((await throttle.peek('10.0.0.1')).failures).toBe(2);

    await throttle.clear('10.0.0.1');
    expect(await throttle.peek('10.0.0.1')).toEqual({ failures: 0, blocked: false });

    // The whole budget is available again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await throttle.recordFailure('10.0.0.1')).blocked).toBe(false);
    }
  });

  it('treats a missing or malformed max as at least one attempt', async () => {
    const throttle = createAuthFailureThrottle({ maxFailures: 0, windowMs: 60_000, blockMs: 60_000 });
    expect((await throttle.recordFailure('k')).blocked).toBe(false);
    expect((await throttle.recordFailure('k')).blocked).toBe(true);
  });
});

describe('authMiddleware failure throttling', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    const { resetRequestRateLimitStore } = await import('./requestRateLimit.js');
    resetRequestRateLimitStore();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns 429 with retry-after once the failure budget is exhausted', async () => {
    const { authMiddleware } = await import('./auth.js');
    const { adminAuthThrottle, adminAuthThrottleDefaults } = await import('./authFailureThrottle.js');

    app = Fastify();
    app.addHook('onRequest', authMiddleware);
    app.get('/api/guarded', async () => ({ ok: true }));

    // Start from a clean budget for this source.
    await adminAuthThrottle.clear('127.0.0.1');

    let sawBlocked = false;
    // The default budget is bounded, so this loop terminates well before the cap.
    for (let attempt = 0; attempt < adminAuthThrottleDefaults.maxFailures + 2; attempt += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/guarded',
        headers: { Authorization: 'Bearer definitely-not-the-token' },
      });
      if (res.statusCode === 429) {
        sawBlocked = true;
        expect(res.headers['retry-after']).toBeTruthy();
        expect(res.json()).toMatchObject({ error: expect.stringContaining('Too many') });
        break;
      }
      expect(res.statusCode).toBe(403);
    }
    expect(sawBlocked).toBe(true);

    await adminAuthThrottle.clear('127.0.0.1');
  });

  it('lets a valid credential through and resets the failure budget', async () => {
    const { authMiddleware } = await import('./auth.js');
    const { adminAuthThrottle } = await import('./authFailureThrottle.js');
    const { config } = await import('../config.js');

    app = Fastify();
    app.addHook('onRequest', authMiddleware);
    app.get('/api/guarded', async () => ({ ok: true }));

    await adminAuthThrottle.clear('127.0.0.1');

    // Burn part of the budget, then authenticate successfully.
    await app.inject({
      method: 'GET',
      url: '/api/guarded',
      headers: { Authorization: 'Bearer wrong' },
    });
    expect((await adminAuthThrottle.peek('127.0.0.1')).failures).toBe(1);

    const ok = await app.inject({
      method: 'GET',
      url: '/api/guarded',
      headers: { Authorization: `Bearer ${config.authToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect((await adminAuthThrottle.peek('127.0.0.1')).failures).toBe(0);
  });

  it('never refuses a valid credential, even while the address is blocked', async () => {
    const { authMiddleware } = await import('./auth.js');
    const { adminAuthThrottle } = await import('./authFailureThrottle.js');
    const { config } = await import('../config.js');

    app = Fastify();
    app.addHook('onRequest', authMiddleware);
    app.get('/api/guarded', async () => ({ ok: true }));

    // Exhaust the budget for this address, as a stranger guessing tokens would.
    await adminAuthThrottle.clear('127.0.0.1');
    while (!(await adminAuthThrottle.peek('127.0.0.1')).blocked) {
      await adminAuthThrottle.recordFailure('127.0.0.1');
    }

    // A blocked address must NOT lock the real operator out: the credential is
    // checked before the budget, so the right token still works. This is the
    // property that keeps a tunnel-wide shared address (the connector) safe.
    const ok = await app.inject({
      method: 'GET',
      url: '/api/guarded',
      headers: { Authorization: `Bearer ${config.authToken}` },
    });
    expect(ok.statusCode).toBe(200);

    // And that successful call clears the block for subsequent requests.
    expect(await adminAuthThrottle.peek('127.0.0.1')).toEqual({ failures: 0, blocked: false });

    // Meanwhile a wrong token from the same address is still refused (429).
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/guarded',
      headers: { Authorization: 'Bearer still-wrong' },
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('accepts case-insensitive bearer scheme and does not spend throttle budget', async () => {
    const { authMiddleware } = await import('./auth.js');
    const { adminAuthThrottle } = await import('./authFailureThrottle.js');
    const { config } = await import('../config.js');

    app = Fastify();
    app.addHook('onRequest', authMiddleware);
    app.get('/api/guarded', async () => ({ ok: true }));

    await adminAuthThrottle.clear('127.0.0.1');

    // The proxy surface parses the scheme case-insensitively; a client that
    // sends 'bearer' must not be treated as an invalid credential and burn
    // the failure budget per request (10 in 5 min → lockout).
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/guarded',
        headers: { Authorization: `${scheme} ${config.authToken}` },
      });
      expect(res.statusCode).toBe(200);
    }
    expect((await adminAuthThrottle.peek('127.0.0.1')).failures).toBe(0);

    // A non-bearer scheme stays rejected.
    const other = await app.inject({
      method: 'GET',
      url: '/api/guarded',
      headers: { Authorization: `Token ${config.authToken}` },
    });
    expect(other.statusCode).toBe(403);

    await adminAuthThrottle.clear('127.0.0.1');
  });
});
