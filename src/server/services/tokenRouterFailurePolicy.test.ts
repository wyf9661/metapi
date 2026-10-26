import { describe, expect, it } from 'vitest';
import {
  clampFailureCooldownMs,
  resolveChannelCooldownMsWithUpstreamHint,
  resolveConfiguredFailureCooldownMaxMs,
  resolveEffectiveFailureCooldownMs,
} from './tokenRouterFailurePolicy.js';

const CEILING = resolveConfiguredFailureCooldownMaxMs();

describe('resolveChannelCooldownMsWithUpstreamHint', () => {
  it('matches the local backoff when the upstream said nothing', () => {
    for (const failCount of [0, 1, 2, 5]) {
      expect(resolveChannelCooldownMsWithUpstreamHint(failCount, 1, null))
        .toBe(resolveEffectiveFailureCooldownMs(failCount, 1));
      expect(resolveChannelCooldownMsWithUpstreamHint(failCount, 1, undefined))
        .toBe(resolveEffectiveFailureCooldownMs(failCount, 1));
      expect(resolveChannelCooldownMsWithUpstreamHint(failCount, 1, 0))
        .toBe(resolveEffectiveFailureCooldownMs(failCount, 1));
      expect(resolveChannelCooldownMsWithUpstreamHint(failCount, 1, -5))
        .toBe(resolveEffectiveFailureCooldownMs(failCount, 1));
    }
  });

  it('extends the wait when the vendor asks for longer', () => {
    const local = resolveEffectiveFailureCooldownMs(0, 1);
    const extended = resolveChannelCooldownMsWithUpstreamHint(0, 1, 120_000);
    expect(extended).toBeGreaterThan(local);
    expect(extended).toBe(Math.min(120_000, CEILING));
  });

  it('never shortens the local backoff', () => {
    const local = resolveEffectiveFailureCooldownMs(3, 1.8);
    expect(resolveChannelCooldownMsWithUpstreamHint(3, 1.8, 1_000)).toBe(local);
  });

  it('stays inside the configured ceiling', () => {
    const value = resolveChannelCooldownMsWithUpstreamHint(0, 1, 24 * 60 * 60 * 1000);
    expect(value).toBeLessThanOrEqual(CEILING);
    expect(value).toBe(CEILING);
  });

  it('is bounded the same way clampFailureCooldownMs bounds a local backoff', () => {
    expect(clampFailureCooldownMs(Number.MAX_SAFE_INTEGER)).toBe(CEILING);
    expect(resolveChannelCooldownMsWithUpstreamHint(0, 1, Number.MAX_SAFE_INTEGER)).toBe(CEILING);
  });

  it('applies the failure-class weight before the hint comparison', () => {
    const unhinted = resolveChannelCooldownMsWithUpstreamHint(2, 1.8, null);
    const plain = resolveChannelCooldownMsWithUpstreamHint(2, 1, null);
    expect(unhinted).toBeGreaterThan(plain);
    // A short hint cannot cancel the weighted local floor.
    expect(resolveChannelCooldownMsWithUpstreamHint(2, 1.8, 500)).toBe(unhinted);
  });
});
