import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetManagedKeyRpmWindowsForTests,
  checkManagedKeyRpmLimit,
} from './downstreamApiKeyService.js';

describe('checkManagedKeyRpmLimit', () => {
  beforeEach(() => {
    __resetManagedKeyRpmWindowsForTests();
  });

  it('allows unlimited when maxRpm is null/0', () => {
    expect(checkManagedKeyRpmLimit(1, null).allowed).toBe(true);
    expect(checkManagedKeyRpmLimit(1, 0).allowed).toBe(true);
  });

  it('blocks after N requests in rolling minute', () => {
    const now = 1_000_000;
    expect(checkManagedKeyRpmLimit(7, 2, now).allowed).toBe(true);
    expect(checkManagedKeyRpmLimit(7, 2, now + 10).allowed).toBe(true);
    const blocked = checkManagedKeyRpmLimit(7, 2, now + 20);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('recovers after window slides', () => {
    const now = 2_000_000;
    expect(checkManagedKeyRpmLimit(9, 1, now).allowed).toBe(true);
    expect(checkManagedKeyRpmLimit(9, 1, now + 1).allowed).toBe(false);
    expect(checkManagedKeyRpmLimit(9, 1, now + 60_001).allowed).toBe(true);
  });
});
