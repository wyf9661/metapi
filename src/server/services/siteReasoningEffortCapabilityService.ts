/**
 * Per-site × upstream-protocol reasoning-effort ceiling learned from real traffic.
 *
 * A relay's accepted effort ladder is not discoverable from its metadata: some
 * take low/medium/high only (rejecting `max`), some refuse `xhigh`, and the
 * refusal only surfaces as a 400 after the value was already sent. Without a
 * memory of that verdict every request opened with the same rejected value and
 * re-burned the same 400.
 *
 * The first rejection teaches a ceiling for that site + protocol; later requests
 * go out already clamped, so the failure stops repeating. Retries inside the
 * request that taught it are handled separately (the body is downgraded one rung
 * for the next attempt).
 *
 * Storage is in-process and time-boxed on purpose: upstreams do get upgraded, so
 * a learned ceiling must expire, and a restart simply re-learns it from the next
 * rejection. Nothing here is authoritative routing state — the router never
 * filters channels on it, it only shapes the request body.
 */
import {
  REASONING_EFFORT_LADDER,
  capReasoningEffortInBody,
  nextLowerReasoningEffort,
  readReasoningEffortFromBody,
} from './reasoningEffort.js';

export type ReasoningEffortCeiling = {
  /** Highest effort rung this site+protocol is known to accept. */
  maxEffort: string;
  /** When the rejection that taught it was observed. */
  learnedAtMs: number;
  /** Value the upstream actually rejected. */
  rejectedEffort: string | null;
};

/** How long a learned ceiling stays in force before the site gets a fresh chance. */
export const REASONING_EFFORT_CEILING_TTL_MS = 24 * 60 * 60 * 1000;

const ceilings = new Map<string, ReasoningEffortCeiling>();

function ceilingKey(siteId: number, endpoint: string): string {
  return `${Math.trunc(siteId)}|${String(endpoint || '').trim().toLowerCase()}`;
}

function ladderIndex(value: string): number {
  return (REASONING_EFFORT_LADDER as readonly string[]).indexOf(value);
}

let lastPruneMs = 0;

function pruneExpired(nowMs: number): void {
  // Writes are rare (one per rejection); pruning on write keeps the map bounded
  // without a timer.
  if (nowMs - lastPruneMs < 60_000) return;
  lastPruneMs = nowMs;
  for (const [key, entry] of ceilings) {
    if (nowMs - entry.learnedAtMs >= REASONING_EFFORT_CEILING_TTL_MS) {
      ceilings.delete(key);
    }
  }
}

/**
 * Record that `siteId` rejected an effort value on `endpoint`, tightening the
 * ceiling to the rung below the rejected one. The ceiling only ever moves down:
 * a relay that refuses `max` and then refuses `xhigh` ends up at `high`.
 *
 * Returns the ceiling now in force, or null when the rejection taught nothing
 * (unknown value at the floor of the ladder).
 */
export function recordReasoningEffortRejection(input: {
  siteId: number;
  endpoint: string;
  effort: string | null | undefined;
  nowMs?: number;
}): string | null {
  const nowMs = input.nowMs ?? Date.now();
  const rejected = typeof input.effort === 'string' ? input.effort.trim() : '';
  const taught = nextLowerReasoningEffort(rejected);
  if (!taught) return resolveReasoningEffortCeiling(input.siteId, input.endpoint, nowMs);

  const key = ceilingKey(input.siteId, input.endpoint);
  const existing = ceilings.get(key);
  const stillFresh = existing && nowMs - existing.learnedAtMs < REASONING_EFFORT_CEILING_TTL_MS;
  if (stillFresh && existing && ladderIndex(existing.maxEffort) <= ladderIndex(taught)) {
    // Already at or below this rung: keep the tighter ceiling, just refresh it.
    existing.learnedAtMs = nowMs;
    return existing.maxEffort;
  }

  ceilings.set(key, {
    maxEffort: taught,
    learnedAtMs: nowMs,
    rejectedEffort: rejected || null,
  });
  pruneExpired(nowMs);
  return taught;
}

/**
 * Record an explicit ceiling (usually parsed from the relay's own "valid
 * levels" list) instead of stepping down one rung from the rejected value.
 * Only ever tightens an existing fresh ceiling, mirroring
 * recordReasoningEffortRejection.
 */
export function recordReasoningEffortCeiling(input: {
  siteId: number;
  endpoint: string;
  maxEffort: string;
  rejectedEffort?: string | null;
  nowMs?: number;
}): string | null {
  const nowMs = input.nowMs ?? Date.now();
  const maxEffort = typeof input.maxEffort === 'string' ? input.maxEffort.trim() : '';
  if (ladderIndex(maxEffort) < 0) return null;
  const key = ceilingKey(input.siteId, input.endpoint);
  const existing = ceilings.get(key);
  const stillFresh = existing && nowMs - existing.learnedAtMs < REASONING_EFFORT_CEILING_TTL_MS;
  if (stillFresh && existing && ladderIndex(existing.maxEffort) <= ladderIndex(maxEffort)) {
    existing.learnedAtMs = nowMs;
    return existing.maxEffort;
  }
  ceilings.set(key, {
    maxEffort,
    learnedAtMs: nowMs,
    rejectedEffort: input.rejectedEffort || null,
  });
  pruneExpired(nowMs);
  return maxEffort;
}

/** The ceiling currently in force for a site+protocol, or null when unknown/expired. */
export function resolveReasoningEffortCeiling(
  siteId: number,
  endpoint: string,
  nowMs = Date.now(),
): string | null {
  const entry = ceilings.get(ceilingKey(siteId, endpoint));
  if (!entry) return null;
  if (nowMs - entry.learnedAtMs >= REASONING_EFFORT_CEILING_TTL_MS) {
    ceilings.delete(ceilingKey(siteId, endpoint));
    return null;
  }
  return entry.maxEffort;
}

/**
 * Clamp a built upstream request body to the ceiling learned for this
 * site+protocol. Returns the value written, or null when there is no ceiling or
 * the body was already at or below it.
 */
export function clampRequestBodyToSiteEffortCeiling(
  body: Record<string, unknown> | null | undefined,
  siteId: number,
  endpoint: string,
  nowMs = Date.now(),
): string | null {
  const ceiling = resolveReasoningEffortCeiling(siteId, endpoint, nowMs);
  if (!ceiling) return null;
  return capReasoningEffortInBody(body, ceiling);
}

/**
 * Learn from a failed attempt: only when the error names the effort and the body
 * actually carried a value to downgrade.
 */
export function learnReasoningEffortCeilingFromFailure(input: {
  siteId: number;
  endpoint: string;
  errorText: string | null | undefined;
  body: Record<string, unknown> | null | undefined;
  /** Explicit ceiling (e.g. parsed from a "valid levels" list); skips the one-rung step-down. */
  taughtCeiling?: string | null;
  nowMs?: number;
}): string | null {
  const effort = readReasoningEffortFromBody(input.body);
  if (!effort) return null;
  if (input.taughtCeiling) {
    return recordReasoningEffortCeiling({
      siteId: input.siteId,
      endpoint: input.endpoint,
      maxEffort: input.taughtCeiling,
      rejectedEffort: effort,
      nowMs: input.nowMs,
    });
  }
  return recordReasoningEffortRejection({
    siteId: input.siteId,
    endpoint: input.endpoint,
    effort,
    nowMs: input.nowMs,
  });
}

/** Test-only: drop all learned ceilings. */
export function __resetReasoningEffortCeilingsForTests(): void {
  ceilings.clear();
  lastPruneMs = 0;
}
