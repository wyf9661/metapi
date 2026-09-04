import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetManagedKeyInflightForTests,
  releaseManagedKeyInflight,
  tryAcquireManagedKeyInflight,
} from './downstreamApiKeyService.js';

describe('managed key in-flight limit', () => {
  beforeEach(() => {
    __resetManagedKeyInflightForTests();
  });

  it('allows unlimited when maxInflight is null/0/negative', () => {
    expect(tryAcquireManagedKeyInflight(1, null)).toBe(true);
    expect(tryAcquireManagedKeyInflight(1, 0)).toBe(true);
    expect(tryAcquireManagedKeyInflight(1, -1)).toBe(true);
    expect(tryAcquireManagedKeyInflight(1, undefined)).toBe(true);
  });

  it('blocks once the concurrent in-flight ceiling is reached', () => {
    const keyId = 7;
    expect(tryAcquireManagedKeyInflight(keyId, 2)).toBe(true);
    expect(tryAcquireManagedKeyInflight(keyId, 2)).toBe(true);
    expect(tryAcquireManagedKeyInflight(keyId, 2)).toBe(false);
  });

  it('recovers after release', () => {
    const keyId = 9;
    expect(tryAcquireManagedKeyInflight(keyId, 2)).toBe(true);
    expect(tryAcquireManagedKeyInflight(keyId, 2)).toBe(true);
    expect(tryAcquireManagedKeyInflight(keyId, 2)).toBe(false);

    releaseManagedKeyInflight(keyId);
    expect(tryAcquireManagedKeyInflight(keyId, 2)).toBe(true);
  });

  it('release is idempotent and never drives the count negative', () => {
    const keyId = 11;
    expect(tryAcquireManagedKeyInflight(keyId, 1)).toBe(true);
    releaseManagedKeyInflight(keyId);
    releaseManagedKeyInflight(keyId); // extra release must be a no-op
    releaseManagedKeyInflight(999);   // unknown key release must be a no-op
    expect(tryAcquireManagedKeyInflight(keyId, 1)).toBe(true);
  });

  it('keeps per-key isolation', () => {
    expect(tryAcquireManagedKeyInflight(101, 1)).toBe(true);
    expect(tryAcquireManagedKeyInflight(102, 1)).toBe(true);
    expect(tryAcquireManagedKeyInflight(101, 1)).toBe(false);
    expect(tryAcquireManagedKeyInflight(102, 1)).toBe(false);
    releaseManagedKeyInflight(101);
    expect(tryAcquireManagedKeyInflight(101, 1)).toBe(true);
    expect(tryAcquireManagedKeyInflight(102, 1)).toBe(false);
  });
});
