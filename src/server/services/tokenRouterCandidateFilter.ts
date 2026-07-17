import { clampFailureCooldownMs, resolveFailureBackoffSec } from './tokenRouterMath.js';

export type FailureAwareChannel = {
  failCount?: number | null;
  lastFailAt?: string | null;
};

export function isChannelRecentlyFailed(
  channel: FailureAwareChannel,
  nowMs: number,
  maxCooldownMs: number,
  avoidSec = resolveFailureBackoffSec(channel.failCount),
): boolean {
  const avoidMs = clampFailureCooldownMs(avoidSec * 1000, maxCooldownMs);
  if (avoidMs <= 0) return false;
  if ((channel.failCount ?? 0) <= 0) return false;
  if (!channel.lastFailAt) return false;

  const failTs = Date.parse(channel.lastFailAt);
  if (Number.isNaN(failTs)) return false;
  return nowMs - failTs < avoidMs;
}

export function filterRecentlyFailedCandidates<T extends { channel: FailureAwareChannel }>(
  candidates: T[],
  nowMs: number,
  maxCooldownMs: number,
  avoidSec?: number,
): T[] {
  if (candidates.length <= 1) return candidates;
  if (avoidSec != null && avoidSec <= 0) return candidates;

  const healthy = candidates.filter((candidate) => (
    avoidSec == null
      ? !isChannelRecentlyFailed(candidate.channel, nowMs, maxCooldownMs)
      : !isChannelRecentlyFailed(candidate.channel, nowMs, maxCooldownMs, avoidSec)
  ));
  // Preserve availability when every candidate is cooling down; weighting can still choose the least-bad option.
  return healthy.length > 0 ? healthy : candidates;
}
