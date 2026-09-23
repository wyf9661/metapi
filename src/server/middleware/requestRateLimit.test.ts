import { describe, expect, it } from 'vitest';
import {
  __getRateLimitSeenKeyStatsForTests,
  createRateLimitGuard,
  resetRequestRateLimitStore,
} from './requestRateLimit.js';

function fakeRequest(ip: string) {
  return { ip, headers: {} } as never;
}

function fakeReply() {
  const state = { statusCode: 0 };
  const reply = {
    code(code: number) {
      state.statusCode = code;
      return reply;
    },
    header() {
      return reply;
    },
    send() {
      return reply;
    },
  };
  return { reply: reply as never, state };
}

describe('createRateLimitGuard seen-key tracking', () => {
  it('keeps per-bucket seen-key tracking bounded under many unique client IPs', async () => {
    resetRequestRateLimitStore();
    const guard = createRateLimitGuard({
      bucket: 'bounded-tracking-test',
      // Generous budget: this test exercises key bookkeeping, not 429s.
      max: 1_000_000,
      windowMs: 60_000,
    });

    for (let i = 0; i < 700; i += 1) {
      const { reply } = fakeReply();
      await guard(fakeRequest(`10.${Math.floor(i / 256) % 256}.${i % 256}.7`), reply);
    }

    const stats = __getRateLimitSeenKeyStatsForTests();
    const bucketStats = stats.find((entry) => entry.bucket === 'bounded-tracking-test');
    expect(bucketStats).toBeDefined();
    expect(bucketStats!.seenKeys).toBeLessThanOrEqual(512);
    resetRequestRateLimitStore();
  });

  it('still enforces the per-window budget across unique IPs', async () => {
    resetRequestRateLimitStore();
    const guard = createRateLimitGuard({
      bucket: 'bounded-tracking-budget',
      max: 2,
      windowMs: 60_000,
    });

    let rejected = 0;
    for (let i = 0; i < 5; i += 1) {
      const { reply, state } = fakeReply();
      await guard(fakeRequest('10.9.9.9'), reply);
      if (state.statusCode === 429) rejected += 1;
    }
    expect(rejected).toBe(3);
    resetRequestRateLimitStore();
  });

  it('reset clears limiter state so a fresh budget is available afterwards', async () => {
    resetRequestRateLimitStore();
    const guard = createRateLimitGuard({
      bucket: 'bounded-tracking-reset',
      max: 1,
      windowMs: 60_000,
    });

    const { reply: firstReply, state: firstState } = fakeReply();
    await guard(fakeRequest('10.8.8.8'), firstReply);
    expect(firstState.statusCode).toBe(0);

    const { reply: secondReply, state: secondState } = fakeReply();
    await guard(fakeRequest('10.8.8.8'), secondReply);
    expect(secondState.statusCode).toBe(429);

    resetRequestRateLimitStore();

    const { reply: thirdReply, state: thirdState } = fakeReply();
    await guard(fakeRequest('10.8.8.8'), thirdReply);
    expect(thirdState.statusCode).toBe(0);
  });
});
