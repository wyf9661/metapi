import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { blendRecentOutcomeSnapshots as blendRecentOutcomeSnapshotsMath, clampNumber, isRecord, type RecentOutcomeSnapshot } from './tokenRouterMath.js';
import {
  applyRuntimeHealthFailure,
  applyRuntimeHealthSoftFailure,
  applyRuntimeHealthSuccess,
  cloneSiteRuntimeHealthState,
  createSiteRuntimeHealthState,
  getDecayedSiteRuntimePenalty,
  getRecentSiteRuntimeOutcomeSnapshot,
  getRuntimeHealthMultiplier,
  hydrateSiteRuntimeHealthState,
  isRuntimeHealthBreakerOpen,
  shouldPersistSiteRuntimeHealthState,
  SITE_RUNTIME_MIN_MULTIPLIER,
  type SiteRuntimeHealthState,
} from './siteRuntimeHealth.js';
import { isWafBlockedRuntimeFailure, type SiteRuntimeFailureContext } from './siteFailureClassification.js';
import { canonicalizeModelName } from '../shared/modelCanonicalization.js';
import { isExactRouteModelPattern } from './tokenRouterModelPatterns.js';

const SITE_RUNTIME_HEALTH_SETTING_KEY = 'token_router_site_runtime_health_v1';
const SITE_RUNTIME_HEALTH_PERSIST_DEBOUNCE_MS = 500;
const SITE_RECENT_MODEL_WEIGHT = 0.65;

export type SiteRuntimeHealthDetails = {
  globalMultiplier: number;
  modelMultiplier: number;
  combinedMultiplier: number;
  globalBreakerOpen: boolean;
  modelBreakerOpen: boolean;
  modelKey: string;
  recentSuccessRate: number;
  recentSampleCount: number;
  recentConfidence: number;
};

type SiteRuntimeHealthPersistencePayload = {
  version: 1;
  savedAtMs: number;
  globalBySiteId: Record<string, SiteRuntimeHealthState>;
  modelBySiteId: Record<string, Record<string, SiteRuntimeHealthState>>;
};

const siteRuntimeHealthStates = new Map<number, SiteRuntimeHealthState>();
const siteModelRuntimeHealthStates = new Map<number, Map<string, SiteRuntimeHealthState>>();
let siteRuntimeHealthLoaded = false;
let siteRuntimeHealthLoadPromise: Promise<void> | null = null;
let siteRuntimeHealthSaveTimer: ReturnType<typeof setTimeout> | null = null;
let siteRuntimeHealthPersistInFlight: Promise<void> | null = null;

// Optional hooks so tokenRouter can still clear its own stable-first maps on reset.
let onResetExtra: (() => void) | null = null;

export function setTokenRouterRuntimeHealthResetHook(hook: (() => void) | null): void {
  onResetExtra = hook;
}

function normalizeModelAlias(modelName: string): string {
  return canonicalizeModelName(modelName);
}

function getRecentOutcomeSnapshot(state: SiteRuntimeHealthState | null | undefined, nowMs = Date.now()): RecentOutcomeSnapshot {
  return getRecentSiteRuntimeOutcomeSnapshot(state, nowMs);
}

function blendRecentOutcomeSnapshots(
  globalSnapshot: RecentOutcomeSnapshot,
  modelSnapshot: RecentOutcomeSnapshot | null,
): RecentOutcomeSnapshot {
  return blendRecentOutcomeSnapshotsMath(globalSnapshot, modelSnapshot, SITE_RECENT_MODEL_WEIGHT);
}

function getOrCreateRuntimeHealthState<K>(states: Map<K, SiteRuntimeHealthState>, key: K, nowMs = Date.now()): SiteRuntimeHealthState {
  const existing = states.get(key);
  if (!existing) {
    const initial = createSiteRuntimeHealthState(nowMs);
    states.set(key, initial);
    return initial;
  }

  const nextPenalty = getDecayedSiteRuntimePenalty(existing, nowMs);
  if (nextPenalty !== existing.penaltyScore || existing.lastUpdatedAtMs !== nowMs) {
    existing.penaltyScore = nextPenalty;
    existing.lastUpdatedAtMs = nowMs;
  }
  return existing;
}

function getOrCreateSiteRuntimeHealthState(siteId: number, nowMs = Date.now()): SiteRuntimeHealthState {
  return getOrCreateRuntimeHealthState(siteRuntimeHealthStates, siteId, nowMs);
}

function getSiteModelRuntimeHealthState(siteId: number, modelName?: string | null): SiteRuntimeHealthState | null {
  const modelKey = normalizeModelAlias(modelName || '');
  if (!modelKey) return null;
  return siteModelRuntimeHealthStates.get(siteId)?.get(modelKey) ?? null;
}

function getOrCreateSiteModelRuntimeHealthState(
  siteId: number,
  modelName?: string | null,
  nowMs = Date.now(),
): SiteRuntimeHealthState | null {
  const modelKey = normalizeModelAlias(modelName || '');
  if (!modelKey) return null;
  let modelStates = siteModelRuntimeHealthStates.get(siteId);
  if (!modelStates) {
    modelStates = new Map<string, SiteRuntimeHealthState>();
    siteModelRuntimeHealthStates.set(siteId, modelStates);
  }
  return getOrCreateRuntimeHealthState(modelStates, modelKey, nowMs);
}

export function getSiteRuntimeHealthDetails(siteId: number, modelName?: string | null, nowMs = Date.now()): SiteRuntimeHealthDetails {
  const modelKey = normalizeModelAlias(modelName || '');
  const globalState = siteRuntimeHealthStates.get(siteId);
  const modelState = modelKey ? getSiteModelRuntimeHealthState(siteId, modelKey) : null;
  const globalMultiplier = getRuntimeHealthMultiplier(globalState, nowMs);
  const modelMultiplier = modelState ? getRuntimeHealthMultiplier(modelState, nowMs) : 1;
  const globalRecentSnapshot = getRecentOutcomeSnapshot(globalState, nowMs);
  const modelRecentSnapshot = modelState ? getRecentOutcomeSnapshot(modelState, nowMs) : null;
  const recentSnapshot = blendRecentOutcomeSnapshots(globalRecentSnapshot, modelRecentSnapshot);
  return {
    globalMultiplier,
    modelMultiplier,
    combinedMultiplier: clampNumber(
      globalMultiplier * modelMultiplier,
      SITE_RUNTIME_MIN_MULTIPLIER * SITE_RUNTIME_MIN_MULTIPLIER,
      1,
    ),
    globalBreakerOpen: isRuntimeHealthBreakerOpen(globalState, nowMs),
    modelBreakerOpen: isRuntimeHealthBreakerOpen(modelState, nowMs),
    modelKey,
    recentSuccessRate: recentSnapshot.successRate,
    recentSampleCount: recentSnapshot.sampleCount,
    recentConfidence: recentSnapshot.confidence,
  };
}

function buildSiteRuntimeHealthPersistencePayload(nowMs = Date.now()): SiteRuntimeHealthPersistencePayload {
  const globalBySiteId: Record<string, SiteRuntimeHealthState> = {};
  const modelBySiteId: Record<string, Record<string, SiteRuntimeHealthState>> = {};

  for (const [siteId, state] of siteRuntimeHealthStates.entries()) {
    if (!shouldPersistSiteRuntimeHealthState(state, nowMs)) continue;
    globalBySiteId[String(siteId)] = cloneSiteRuntimeHealthState(state);
  }

  for (const [siteId, modelStates] of siteModelRuntimeHealthStates.entries()) {
    const persistedModels: Record<string, SiteRuntimeHealthState> = {};
    for (const [modelKey, state] of modelStates.entries()) {
      if (!shouldPersistSiteRuntimeHealthState(state, nowMs)) continue;
      persistedModels[modelKey] = cloneSiteRuntimeHealthState(state);
    }
    if (Object.keys(persistedModels).length > 0) {
      modelBySiteId[String(siteId)] = persistedModels;
    }
  }

  return {
    version: 1,
    savedAtMs: nowMs,
    globalBySiteId,
    modelBySiteId,
  };
}

export async function persistSiteRuntimeHealthState(): Promise<void> {
  if (siteRuntimeHealthPersistInFlight) {
    await siteRuntimeHealthPersistInFlight;
    return;
  }
  const persistTask = (async () => {
    const payload = buildSiteRuntimeHealthPersistencePayload();
    await upsertSetting(SITE_RUNTIME_HEALTH_SETTING_KEY, payload);
  })();
  siteRuntimeHealthPersistInFlight = persistTask.finally(() => {
    if (siteRuntimeHealthPersistInFlight === persistTask) {
      siteRuntimeHealthPersistInFlight = null;
    }
  });
  await siteRuntimeHealthPersistInFlight;
}

function scheduleSiteRuntimeHealthPersistence(): void {
  if (siteRuntimeHealthSaveTimer) return;
  siteRuntimeHealthSaveTimer = setTimeout(() => {
    siteRuntimeHealthSaveTimer = null;
    void persistSiteRuntimeHealthState().catch((error) => {
      console.error('Failed to persist site runtime health state', error);
    });
  }, SITE_RUNTIME_HEALTH_PERSIST_DEBOUNCE_MS);
}

async function loadSiteRuntimeHealthStateFromSettings(): Promise<void> {
  siteRuntimeHealthStates.clear();
  siteModelRuntimeHealthStates.clear();

  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, SITE_RUNTIME_HEALTH_SETTING_KEY))
    .get();
  if (!row?.value) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;

  const globalBySiteId = isRecord(parsed.globalBySiteId) ? parsed.globalBySiteId : {};
  for (const [siteIdKey, stateRaw] of Object.entries(globalBySiteId)) {
    const siteId = Number(siteIdKey);
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    const state = hydrateSiteRuntimeHealthState(stateRaw);
    if (!state) continue;
    siteRuntimeHealthStates.set(siteId, state);
  }

  const modelBySiteId = isRecord(parsed.modelBySiteId) ? parsed.modelBySiteId : {};
  for (const [siteIdKey, modelStatesRaw] of Object.entries(modelBySiteId)) {
    const siteId = Number(siteIdKey);
    if (!Number.isFinite(siteId) || siteId <= 0 || !isRecord(modelStatesRaw)) continue;
    const hydratedModelStates = new Map<string, SiteRuntimeHealthState>();
    for (const [rawModelKey, stateRaw] of Object.entries(modelStatesRaw)) {
      const modelKey = normalizeModelAlias(rawModelKey);
      if (!modelKey) continue;
      const state = hydrateSiteRuntimeHealthState(stateRaw);
      if (!state) continue;
      hydratedModelStates.set(modelKey, state);
    }
    if (hydratedModelStates.size > 0) {
      siteModelRuntimeHealthStates.set(siteId, hydratedModelStates);
    }
  }
}

export async function ensureSiteRuntimeHealthStateLoaded(): Promise<void> {
  if (siteRuntimeHealthLoaded) return;
  if (!siteRuntimeHealthLoadPromise) {
    siteRuntimeHealthLoadPromise = (async () => {
      try {
        await loadSiteRuntimeHealthStateFromSettings();
        siteRuntimeHealthLoaded = true;
      } catch (error) {
        console.warn('Failed to restore site runtime health state from settings', error);
        siteRuntimeHealthLoadPromise = null;
        siteRuntimeHealthLoaded = false;
      }
    })();
  }
  await siteRuntimeHealthLoadPromise;
}

export function recordSiteRuntimeFailure(siteId: number, context: SiteRuntimeFailureContext = {}, nowMs = Date.now()): void {
  // WAF 403 is usually model/path scoped. Soft-penalize the site-global bucket
  // but open the hard short breaker only on the site+model bucket so other models
  // on the same site remain eligible.
  const globalState = getOrCreateSiteRuntimeHealthState(siteId, nowMs);
  if (isWafBlockedRuntimeFailure(context)) {
    applyRuntimeHealthSoftFailure(globalState, context, nowMs);
  } else {
    applyRuntimeHealthFailure(globalState, context, nowMs);
  }
  const modelState = getOrCreateSiteModelRuntimeHealthState(siteId, context.modelName, nowMs);
  if (modelState) {
    applyRuntimeHealthFailure(modelState, context, nowMs);
  }
  scheduleSiteRuntimeHealthPersistence();
}

export function recordSiteRuntimeSuccess(siteId: number, latencyMs: number, modelName?: string | null, nowMs = Date.now()): void {
  applyRuntimeHealthSuccess(getOrCreateSiteRuntimeHealthState(siteId, nowMs), latencyMs, nowMs);
  const modelState = getOrCreateSiteModelRuntimeHealthState(siteId, modelName, nowMs);
  if (modelState) {
    applyRuntimeHealthSuccess(modelState, latencyMs, nowMs);
  }
  scheduleSiteRuntimeHealthPersistence();
}

export function resetSiteRuntimeHealthState(): void {
  siteRuntimeHealthStates.clear();
  siteModelRuntimeHealthStates.clear();
  siteRuntimeHealthLoaded = false;
  siteRuntimeHealthLoadPromise = null;
  if (siteRuntimeHealthSaveTimer) {
    clearTimeout(siteRuntimeHealthSaveTimer);
    siteRuntimeHealthSaveTimer = null;
  }
  siteRuntimeHealthPersistInFlight = null;
  onResetExtra?.();
}

export async function flushSiteRuntimeHealthPersistence(): Promise<void> {
  if (siteRuntimeHealthSaveTimer) {
    clearTimeout(siteRuntimeHealthSaveTimer);
    siteRuntimeHealthSaveTimer = null;
    await persistSiteRuntimeHealthState();
    return;
  }
  if (siteRuntimeHealthPersistInFlight) {
    await siteRuntimeHealthPersistInFlight;
  }
}

export function clearRuntimeHealthStatesForChannels(rows: Array<{
  siteId: number;
  sourceModel: string | null;
  routeModelPattern: string;
}>): boolean {
  let changed = false;
  const modelKeysBySiteId = new Map<number, Set<string>>();

  for (const row of rows) {
    if (siteRuntimeHealthStates.delete(row.siteId)) {
      changed = true;
    }

    const resolvedModelName = String(row.sourceModel || '').trim()
      || (isExactRouteModelPattern(row.routeModelPattern) ? row.routeModelPattern.trim() : '');
    const modelKey = normalizeModelAlias(resolvedModelName);
    if (!modelKey) continue;
    if (!modelKeysBySiteId.has(row.siteId)) {
      modelKeysBySiteId.set(row.siteId, new Set());
    }
    modelKeysBySiteId.get(row.siteId)!.add(modelKey);
  }

  for (const [siteId, modelKeys] of modelKeysBySiteId.entries()) {
    const modelStates = siteModelRuntimeHealthStates.get(siteId);
    if (!modelStates) continue;
    for (const modelKey of modelKeys) {
      if (modelStates.delete(modelKey)) {
        changed = true;
      }
    }
    if (modelStates.size === 0) {
      siteModelRuntimeHealthStates.delete(siteId);
    }
  }

  return changed;
}

export function getSiteRuntimeHealthMultiplier(siteId: number, nowMs = Date.now()): number {
  const state = siteRuntimeHealthStates.get(siteId);
  return getRuntimeHealthMultiplier(state, nowMs);
}

export function isSiteRuntimeBreakerOpen(siteId: number, nowMs = Date.now()): boolean {
  const state = siteRuntimeHealthStates.get(siteId);
  return isRuntimeHealthBreakerOpen(state, nowMs);
}

export function filterSiteRuntimeBrokenCandidates<T extends { site: { id: number } }>(
  candidates: T[],
  nowMs = Date.now(),
): T[] {
  if (candidates.length <= 1) return candidates;
  const healthy = candidates.filter((candidate) => !isSiteRuntimeBreakerOpen(candidate.site.id, nowMs));
  return healthy.length > 0 ? healthy : candidates;
}

function buildRuntimeBreakerReason(details: SiteRuntimeHealthDetails): string {
  if (details.globalBreakerOpen && details.modelBreakerOpen) {
    return '站点熔断中，模型熔断中，优先避让';
  }
  if (details.globalBreakerOpen) {
    return '站点熔断中，优先避让';
  }
  if (details.modelBreakerOpen) {
    return '模型熔断中，优先避让';
  }
  return '运行时熔断中，优先避让';
}

export function filterSiteRuntimeBrokenCandidatesByModel<T extends { site: { id: number } }>(
  candidates: T[],
  modelName: string | ((candidate: T) => string),
  nowMs = Date.now(),
): {
  candidates: T[];
  avoided: Array<{ candidate: T; reason: string }>;
} {
  if (candidates.length <= 1) {
    return {
      candidates,
      avoided: [],
    };
  }

  const resolveModelName = typeof modelName === 'function'
    ? modelName
    : (() => modelName);
  const avoided: Array<{ candidate: T; reason: string }> = [];
  const healthy = candidates.filter((candidate) => {
    const details = getSiteRuntimeHealthDetails(candidate.site.id, resolveModelName(candidate), nowMs);
    const blocked = details.globalBreakerOpen || details.modelBreakerOpen;
    if (blocked) {
      avoided.push({
        candidate,
        reason: buildRuntimeBreakerReason(details),
      });
    }
    return !blocked;
  });

  return healthy.length > 0
    ? {
      candidates: healthy,
      avoided,
    }
    : {
      candidates,
      avoided: [],
    };
}
