/**
 * Account/model connectivity signals for live routing.
 *
 * Source: model_availability / token_model_availability (probe + live proxy_log).
 * Semantics match marketplace:
 *   null  = never tested (neutral)
 *   true  = recently proven
 *   false = recently failed (soft demotion when alternatives exist)
 */

import { inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { canonicalizeModelName } from '../shared/modelCanonicalization.js';

export type ConnectivitySignal = boolean | null;

export type ConnectivityRecord = {
  connectivity: ConnectivitySignal;
  checkedAtMs: number | null;
  latencyMs: number | null;
};

/** Soft score multiplier for balanced-v2. */
export const CONNECTIVITY_FACTOR_TRUE = 1.25;
export const CONNECTIVITY_FACTOR_NULL = 1.0;
export const CONNECTIVITY_FACTOR_FALSE = 0.12;

/** Stale false should not permanently black-hole a channel. */
const CONNECTIVITY_FALSE_TTL_MS = 24 * 60 * 60 * 1000;
/** Positive proofs stay trusted longer. */
const CONNECTIVITY_TRUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeConnectivityModelKey(modelName: string): string {
  return canonicalizeModelName(modelName);
}

export function connectivityLookupKey(accountId: number, modelName: string): string {
  return `${accountId}:${normalizeConnectivityModelKey(modelName)}`;
}

export function tokenConnectivityLookupKey(tokenId: number, modelName: string): string {
  return `t${tokenId}:${normalizeConnectivityModelKey(modelName)}`;
}

function parseCheckedAtMs(checkedAt: string | null | undefined): number | null {
  if (!checkedAt || typeof checkedAt !== 'string') return null;
  const ms = Date.parse(checkedAt.includes('T') ? checkedAt : `${checkedAt.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function freshnessForConnectivity(
  connectivity: ConnectivitySignal,
  checkedAtMs: number | null,
  nowMs = Date.now(),
): ConnectivitySignal {
  if (connectivity == null) return null;
  if (checkedAtMs == null) return connectivity;
  const age = nowMs - checkedAtMs;
  if (connectivity === false && age > CONNECTIVITY_FALSE_TTL_MS) return null;
  if (connectivity === true && age > CONNECTIVITY_TRUE_TTL_MS) return null;
  return connectivity;
}

export function connectivityScoreFactor(connectivity: ConnectivitySignal): number {
  if (connectivity === true) return CONNECTIVITY_FACTOR_TRUE;
  if (connectivity === false) return CONNECTIVITY_FACTOR_FALSE;
  return CONNECTIVITY_FACTOR_NULL;
}

export function connectivityReasonText(connectivity: ConnectivitySignal): string | null {
  if (connectivity === false) return '连通性不通(探测/实流量)';
  return null;
}

/**
 * Soft avoid: when at least one candidate is not known-false, drop known-false ones.
 * Never empties the pool (all false → keep all).
 */
export function softAvoidDisconnectedCandidates<T>(
  candidates: T[],
  resolveConnectivity: (candidate: T) => ConnectivitySignal,
): {
  candidates: T[];
  avoided: Array<{ candidate: T; reason: string }>;
} {
  if (candidates.length <= 1) {
    return { candidates, avoided: [] };
  }

  const avoided: Array<{ candidate: T; reason: string }> = [];
  const preferred: T[] = [];
  for (const candidate of candidates) {
    const signal = resolveConnectivity(candidate);
    if (signal === false) {
      avoided.push({
        candidate,
        reason: connectivityReasonText(signal) || '连通性不通',
      });
      continue;
    }
    preferred.push(candidate);
  }

  if (preferred.length === 0) {
    return { candidates, avoided: [] };
  }

  return { candidates: preferred, avoided };
}

export type ConnectivityLookup = {
  byAccountModel: Map<string, ConnectivityRecord>;
  byTokenModel: Map<string, ConnectivityRecord>;
  nowMs: number;
};

function pickFresher(
  current: ConnectivityRecord | undefined,
  next: ConnectivityRecord,
): ConnectivityRecord {
  if (!current) return next;
  const cur = current.checkedAtMs ?? 0;
  const nxt = next.checkedAtMs ?? 0;
  return nxt >= cur ? next : current;
}

export async function loadConnectivityLookup(
  accountIds: number[],
  tokenIds: number[] = [],
  nowMs = Date.now(),
): Promise<ConnectivityLookup> {
  const uniqueAccountIds = [...new Set(accountIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const uniqueTokenIds = [...new Set(tokenIds.filter((id) => Number.isSafeInteger(id) && id > 0))];

  const byAccountModel = new Map<string, ConnectivityRecord>();
  const byTokenModel = new Map<string, ConnectivityRecord>();

  if (uniqueAccountIds.length > 0) {
    const rows = await db.select({
      accountId: schema.modelAvailability.accountId,
      modelName: schema.modelAvailability.modelName,
      connectivity: schema.modelAvailability.connectivity,
      latencyMs: schema.modelAvailability.latencyMs,
      checkedAt: schema.modelAvailability.checkedAt,
    })
      .from(schema.modelAvailability)
      .where(inArray(schema.modelAvailability.accountId, uniqueAccountIds))
      .all();

    for (const row of rows) {
      const modelKey = normalizeConnectivityModelKey(row.modelName || '');
      if (!modelKey) continue;
      const checkedAtMs = parseCheckedAtMs(row.checkedAt);
      const raw: ConnectivitySignal = row.connectivity === true
        ? true
        : row.connectivity === false
          ? false
          : null;
      const connectivity = freshnessForConnectivity(raw, checkedAtMs, nowMs);
      const key = connectivityLookupKey(row.accountId, modelKey);
      byAccountModel.set(key, pickFresher(byAccountModel.get(key), {
        connectivity,
        checkedAtMs,
        latencyMs: typeof row.latencyMs === 'number' && Number.isFinite(row.latencyMs)
          ? Math.max(0, Math.round(row.latencyMs))
          : null,
      }));
    }
  }

  if (uniqueTokenIds.length > 0) {
    const rows = await db.select({
      tokenId: schema.tokenModelAvailability.tokenId,
      modelName: schema.tokenModelAvailability.modelName,
      connectivity: schema.tokenModelAvailability.connectivity,
      latencyMs: schema.tokenModelAvailability.latencyMs,
      checkedAt: schema.tokenModelAvailability.checkedAt,
    })
      .from(schema.tokenModelAvailability)
      .where(inArray(schema.tokenModelAvailability.tokenId, uniqueTokenIds))
      .all();

    for (const row of rows) {
      const modelKey = normalizeConnectivityModelKey(row.modelName || '');
      if (!modelKey) continue;
      const checkedAtMs = parseCheckedAtMs(row.checkedAt);
      const raw: ConnectivitySignal = row.connectivity === true
        ? true
        : row.connectivity === false
          ? false
          : null;
      const connectivity = freshnessForConnectivity(raw, checkedAtMs, nowMs);
      const key = tokenConnectivityLookupKey(row.tokenId, modelKey);
      byTokenModel.set(key, pickFresher(byTokenModel.get(key), {
        connectivity,
        checkedAtMs,
        latencyMs: typeof row.latencyMs === 'number' && Number.isFinite(row.latencyMs)
          ? Math.max(0, Math.round(row.latencyMs))
          : null,
      }));
    }
  }

  return { byAccountModel, byTokenModel, nowMs };
}

/**
 * Resolve connectivity for a channel candidate.
 * Prefer token-level row when channel is bound to an explicit token; else account-level.
 * Tries sourceModel first, then requested/mapped model aliases.
 */
export function resolveCandidateConnectivity(
  lookup: ConnectivityLookup,
  input: {
    accountId: number;
    tokenId?: number | null;
    modelNames: Array<string | null | undefined>;
  },
): ConnectivitySignal {
  const models = input.modelNames
    .map((name) => normalizeConnectivityModelKey(String(name || '')))
    .filter(Boolean);
  const uniqueModels = [...new Set(models)];
  if (uniqueModels.length === 0) return null;

  let best: ConnectivityRecord | undefined;

  if (input.tokenId != null && input.tokenId > 0) {
    for (const model of uniqueModels) {
      const hit = lookup.byTokenModel.get(tokenConnectivityLookupKey(input.tokenId, model));
      if (!hit) continue;
      best = pickFresher(best, hit);
    }
  }

  for (const model of uniqueModels) {
    const hit = lookup.byAccountModel.get(connectivityLookupKey(input.accountId, model));
    if (!hit) continue;
    best = pickFresher(best, hit);
  }

  return best?.connectivity ?? null;
}
