/**
 * Best-effort learning of site protocol profiles from live proxy outcomes.
 *
 * When a NewAPI-class site succeeds on /v1/responses (or fails chat with a
 * Codex-requires-responses policy), persist preferResponses=true so future
 * channel selection and endpoint ordering stop preferring chat first.
 *
 * Fire-and-forget: never throws to the proxy path.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  parseSiteProtocolProfile,
  serializeSiteProtocolProfile,
  type SiteProtocolProfile,
} from '../shared/siteProtocolProfile.js';

const LEARNABLE_PLATFORMS = new Set([
  'new-api',
  'one-api',
  'sub2api',
  'openai',
]);

/** In-process debounce: avoid hammering DB on every success for the same site. */
const recentLearnAtBySiteId = new Map<number, number>();
const LEARN_DEBOUNCE_MS = 60_000;
const inFlightBySiteId = new Set<number>();

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatform(platform: unknown): string {
  return asTrimmedString(platform).toLowerCase();
}

function isLearnablePlatform(platform: unknown): boolean {
  const p = normalizePlatform(platform);
  return LEARNABLE_PLATFORMS.has(p) || !p;
}

function looksCodexRequiresResponses(errorText?: string | null): boolean {
  const lower = (errorText || '').toLowerCase();
  if (!lower) return false;
  return (
    lower.includes('codex_requires_responses_protocol')
    || lower.includes('codex clients may only use the openai responses protocol')
    || (
      lower.includes('only use the openai responses protocol')
      && lower.includes('/v1/responses')
    )
    || (
      lower.includes('policy_violation')
      && lower.includes('/v1/responses')
    )
    || (
      lower.includes('unsupported legacy protocol')
      && lower.includes('/v1/chat/completions')
      && lower.includes('/v1/responses')
    )
  );
}

export type ProtocolProfileLearnReason =
  | 'responses_success'
  | 'codex_policy_failure';

export function shouldLearnPreferResponses(input: {
  platform?: string | null;
  endpoint?: string | null;
  reason: ProtocolProfileLearnReason;
  errorText?: string | null;
}): boolean {
  if (!isLearnablePlatform(input.platform)) return false;
  if (input.reason === 'responses_success') {
    return asTrimmedString(input.endpoint).toLowerCase() === 'responses';
  }
  if (input.reason === 'codex_policy_failure') {
    return looksCodexRequiresResponses(input.errorText);
  }
  return false;
}

export function mergePreferResponsesProfile(
  existing: unknown,
  options?: { requireCodexClient?: boolean },
): SiteProtocolProfile {
  const base = parseSiteProtocolProfile(existing);
  return {
    preferResponses: true,
    requireCodexClient: options?.requireCodexClient === true
      ? true
      : base.requireCodexClient,
    credentialMode: base.credentialMode || 'auto',
    notes: base.notes,
  };
}

/**
 * Persist preferResponses=true for a site if not already set.
 * Returns true when a DB write happened.
 */
export async function learnSitePreferResponses(input: {
  siteId: number;
  platform?: string | null;
  endpoint?: string | null;
  reason: ProtocolProfileLearnReason;
  errorText?: string | null;
  requireCodexClient?: boolean;
  nowMs?: number;
}): Promise<boolean> {
  const siteId = Math.trunc(input.siteId);
  if (!Number.isSafeInteger(siteId) || siteId <= 0) return false;
  if (!shouldLearnPreferResponses(input)) return false;

  const nowMs = input.nowMs ?? Date.now();
  const last = recentLearnAtBySiteId.get(siteId);
  // Only debounce after a prior learn attempt for this site (last is undefined until then).
  if (typeof last === 'number' && (nowMs - last) < LEARN_DEBOUNCE_MS) return false;
  if (inFlightBySiteId.has(siteId)) return false;
  inFlightBySiteId.add(siteId);

  try {
    const rowQuery = db.select({
      id: schema.sites.id,
      platform: schema.sites.platform,
      protocolProfile: schema.sites.protocolProfile,
    }).from(schema.sites)
      .where(eq(schema.sites.id, siteId));
    const row = typeof (rowQuery as any).get === 'function'
      ? await Promise.resolve((rowQuery as any).get())
      : null;
    if (!row) return false;
    if (!isLearnablePlatform(input.platform ?? row.platform)) return false;

    const current = parseSiteProtocolProfile(row.protocolProfile);
    if (current.preferResponses) {
      // Already learned / configured — refresh debounce so we stop checking.
      recentLearnAtBySiteId.set(siteId, nowMs);
      return false;
    }

    const next = mergePreferResponsesProfile(row.protocolProfile, {
      requireCodexClient: input.requireCodexClient === true || input.reason === 'codex_policy_failure',
    });
    const serialized = serializeSiteProtocolProfile(next);
    const nowIso = new Date(nowMs).toISOString();
    const updateQuery = db.update(schema.sites).set({
      protocolProfile: serialized,
      updatedAt: nowIso,
    }).where(eq(schema.sites.id, siteId));
    if (typeof (updateQuery as any).run === 'function') {
      await Promise.resolve((updateQuery as any).run());
    }

    recentLearnAtBySiteId.set(siteId, nowMs);
    try {
      const { invalidateTokenRouterCache } = await import('./tokenRouter.js');
      invalidateTokenRouterCache();
    } catch {
      // cache invalidation is best-effort
    }
    console.info(
      `[protocol-learn] site=${siteId} preferResponses=1 reason=${input.reason}`
      + (input.endpoint ? ` endpoint=${input.endpoint}` : ''),
    );
    return true;
  } catch (error) {
    console.warn(
      `[protocol-learn] failed site=${siteId}: ${error instanceof Error ? error.message : String(error || 'unknown')}`,
    );
    return false;
  } finally {
    inFlightBySiteId.delete(siteId);
  }
}

/** Fire-and-forget wrapper for hot proxy paths. */
export function learnSitePreferResponsesBestEffort(input: {
  siteId: number;
  platform?: string | null;
  endpoint?: string | null;
  reason: ProtocolProfileLearnReason;
  errorText?: string | null;
  requireCodexClient?: boolean;
}): void {
  void learnSitePreferResponses(input).catch(() => {
    // already logged
  });
}

export function resetSiteProtocolProfileLearningStateForTests(): void {
  recentLearnAtBySiteId.clear();
  inFlightBySiteId.clear();
}
