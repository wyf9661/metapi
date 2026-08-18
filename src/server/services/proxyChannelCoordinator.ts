import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import {
  getCredentialModeFromExtraConfig,
  hasOauthProvider,
} from './accountExtraConfig.js';
import { normalizeModelAlias } from './tokenRouterModelMatching.js';

type StickyEntry = {
  channelId: number;
  expiresAtMs: number;
  /** Consecutive affinity hits since the binding was (re)created. */
  hitCount?: number;
};

type LastSuccessEntry = {
  channelId: number;
  // When this channel last succeeded for the model. Used ONLY as the
  // persistence sort key (keep freshest entries under the cap); runtime
  // selection uses the entry as a safety net and periodically explores the
  // balanced pool.
  lastSuccessAtMs: number;
  /** Successful preferred uses since the last balanced exploration. */
  hitCount?: number;
};


type ChannelWaiter = {
  cancelled: boolean;
  resolve: (result: AcquireProxyChannelLeaseResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

type ChannelRuntimeState = {
  activeLeaseIds: Set<number>;
  queue: ChannelWaiter[];
};

export type ProxyChannelLoadSnapshot = {
  channelId: number;
  sessionScoped: boolean;
  concurrencyLimit: number;
  activeLeaseCount: number;
  waitingCount: number;
  loadRatio: number;
  saturated: boolean;
};

export type ProxyChannelLease = {
  channelId: number;
  isActive(): boolean;
  release(): void;
  touch(): void;
};

export type AcquireProxyChannelLeaseResult =
  | { status: 'acquired'; lease: ProxyChannelLease }
  | { status: 'timeout'; waitMs: number };

const stickySessionBindings = new Map<string, StickyEntry>();
/** key+model last-success affinity (independent of client session / path). */
const lastSuccessByModelKey = new Map<string, LastSuccessEntry>();
const channelRuntimeStates = new Map<number, ChannelRuntimeState>();
let nextLeaseId = 1;

const PROXY_CHANNEL_AFFINITY_SETTING_KEY = 'proxy_channel_affinity_v1';
const PROXY_CHANNEL_AFFINITY_PERSIST_DEBOUNCE_MS = 500;
const PROXY_CHANNEL_AFFINITY_MAX_ENTRIES = 2_000;

type AffinityPersistencePayload = {
  version: 1;
  savedAtMs: number;
  sticky: Record<string, StickyEntry>;
  lastSuccess: Record<string, LastSuccessEntry>;
};

let affinityLoaded = false;
let affinityLoadPromise: Promise<void> | null = null;
let affinitySaveTimer: ReturnType<typeof setTimeout> | null = null;
let affinityPersistInFlight: Promise<void> | null = null;

type SessionScopedChannelInput =
  | string
  | null
  | undefined
  | {
    extraConfig?: string | null;
    oauthProvider?: string | null;
  };

function shouldUnrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>) {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function cleanupExpiredStickyBindings(nowMs = Date.now()): void {
  for (const [key, entry] of stickySessionBindings.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      stickySessionBindings.delete(key);
    }
  }
  // last-success entries remain available until an exploration replaces the
  // channel after a successful request, or tokenRouter failure handling clears
  // the channel affinity.
}

function touchAffinityEntry<T>(source: Map<string, T>, key: string, entry: T): void {
  source.delete(key);
  source.set(key, entry);
  while (source.size > PROXY_CHANNEL_AFFINITY_MAX_ENTRIES) {
    const oldestKey = source.keys().next().value;
    if (!oldestKey) break;
    source.delete(oldestKey);
  }
}

function buildLastSuccessKey(input: {
  requestedModel?: string | null;
  downstreamApiKeyId?: number | null;
}): string | null {
  // Normalize the model name (strip provider prefixes / date suffixes such as
  // "deepseek-ai/deepseek-v4-flash" vs "deepseek-v4-flash-0731") so that
  // last-success affinity is shared across alias spellings of the same model.
  const model = normalizeModelAlias(String(input.requestedModel || '').trim());
  if (!model) return null;
  const owner = typeof input.downstreamApiKeyId === 'number' && Number.isFinite(input.downstreamApiKeyId)
    ? `key:${Math.trunc(input.downstreamApiKeyId)}`
    : 'key:anonymous';
  return `${owner}|${model}`;
}

function getSessionScopedExtraConfig(input?: SessionScopedChannelInput): string | null | undefined {
  if (typeof input === 'string' || input == null) return input;
  return input.extraConfig;
}

function isSessionScopedChannel(input?: SessionScopedChannelInput): boolean {
  return getCredentialModeFromExtraConfig(getSessionScopedExtraConfig(input)) === 'session'
    || hasOauthProvider(input);
}

function getStickySessionTtlMs(): number {
  return Math.max(30_000, Math.trunc(config.proxyStickySessionTtlMs || 0));
}

function getChannelLeaseTtlMs(): number {
  return Math.max(5_000, Math.trunc(config.proxySessionChannelLeaseTtlMs || 0));
}

function getChannelLeaseKeepaliveMs(): number {
  return Math.max(1_000, Math.trunc(config.proxySessionChannelLeaseKeepaliveMs || 0));
}

function getChannelQueueWaitMs(): number {
  return Math.max(0, Math.trunc(config.proxySessionChannelQueueWaitMs || 0));
}

function getChannelConcurrencyLimit(input?: SessionScopedChannelInput): number {
  if (!isSessionScopedChannel(input)) return 0;
  return Math.max(0, Math.trunc(config.proxySessionChannelConcurrencyLimit || 0));
}

function getOrCreateChannelRuntimeState(channelId: number): ChannelRuntimeState {
  let state = channelRuntimeStates.get(channelId);
  if (!state) {
    state = {
      activeLeaseIds: new Set<number>(),
      queue: [],
    };
    channelRuntimeStates.set(channelId, state);
  }
  return state;
}

function pruneCancelledWaiters(state: ChannelRuntimeState): void {
  if (state.queue.length <= 0) return;
  state.queue = state.queue.filter((waiter) => !waiter.cancelled);
}

function maybeDeleteChannelRuntimeState(channelId: number): void {
  const state = channelRuntimeStates.get(channelId);
  if (!state) return;
  pruneCancelledWaiters(state);
  if (state.activeLeaseIds.size <= 0 && state.queue.every((waiter) => waiter.cancelled)) {
    channelRuntimeStates.delete(channelId);
  }
}

function createNoopLease(channelId: number): ProxyChannelLease {
  return {
    channelId,
    isActive: () => false,
    release: () => {},
    touch: () => {},
  };
}

function isFinitePositiveChannelId(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeAffinityHitCount(value: unknown): number {
  return typeof value === 'number' ? Math.max(0, Math.trunc(value)) : 0;
}

function hydrateAffinityMap(
  target: Map<string, StickyEntry>,
  raw: unknown,
  nowMs: number,
): void {
  if (!raw || typeof raw !== 'object') return;
  for (const [key, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || !isAffinityEntry(entryRaw)) continue;
    if (
      typeof entryRaw.expiresAtMs !== 'number'
      || !Number.isFinite(entryRaw.expiresAtMs)
      || entryRaw.expiresAtMs <= nowMs
    ) continue;
    target.set(normalizedKey, {
      channelId: Math.trunc(entryRaw.channelId),
      expiresAtMs: Math.trunc(entryRaw.expiresAtMs),
      hitCount: normalizeAffinityHitCount(entryRaw.hitCount),
    });
  }
}

function hydrateLastSuccessMap(
  target: Map<string, LastSuccessEntry>,
  raw: unknown,
): void {
  if (!raw || typeof raw !== 'object') return;
  for (const [key, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || !isAffinityEntry(entryRaw)) continue;
    // last-success entries never expire by time; hydrate every valid one.
    // The sort key falls back to the current time when the persisted row
    // predates the lastSuccessAtMs field (legacy schema).
    target.set(normalizedKey, {
      channelId: Math.trunc(entryRaw.channelId),
      lastSuccessAtMs:
        typeof entryRaw.lastSuccessAtMs === 'number'
          ? Math.trunc(entryRaw.lastSuccessAtMs)
          : Date.now(),
      hitCount: normalizeAffinityHitCount(entryRaw.hitCount),
    });
  }
}

function isAffinityEntry(value: unknown): value is Record<string, unknown> & {
  channelId: number;
  expiresAtMs?: number;
  lastSuccessAtMs?: number;
  hitCount?: number;
} {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return isFinitePositiveChannelId(record.channelId);
}

function serializeAffinityMap(
  source: Map<string, StickyEntry>,
  nowMs: number,
): Record<string, StickyEntry> {
  const out: Record<string, StickyEntry> = {};
  // Prefer freshest entries when over the hard cap.
  const live = [...source.entries()]
    .filter(([, entry]) => entry.expiresAtMs > nowMs)
    .sort((a, b) => b[1].expiresAtMs - a[1].expiresAtMs)
    .slice(0, PROXY_CHANNEL_AFFINITY_MAX_ENTRIES);
  for (const [key, entry] of live) {
    out[key] = {
      channelId: entry.channelId,
      expiresAtMs: entry.expiresAtMs,
      ...(typeof entry.hitCount === 'number' ? { hitCount: entry.hitCount } : {}),
    };
  }
  return out;
}

function serializeLastSuccessMap(
  source: Map<string, LastSuccessEntry>,
): Record<string, LastSuccessEntry> {
  const out: Record<string, LastSuccessEntry> = {};
  // No time-based eviction: keep freshest-by-last-success entries only when
  // over the hard cap. Entries survive until the hit cap or failure cooldown
  // clears them.
  const live = [...source.entries()]
    .sort((a, b) => b[1].lastSuccessAtMs - a[1].lastSuccessAtMs)
    .slice(0, PROXY_CHANNEL_AFFINITY_MAX_ENTRIES);
  for (const [key, entry] of live) {
    out[key] = {
      channelId: entry.channelId,
      lastSuccessAtMs: entry.lastSuccessAtMs,
      ...(typeof entry.hitCount === 'number' ? { hitCount: entry.hitCount } : {}),
    };
  }
  return out;
}

function buildAffinityPersistencePayload(nowMs = Date.now()): AffinityPersistencePayload {
  cleanupExpiredStickyBindings(nowMs);
  return {
    version: 1,
    savedAtMs: nowMs,
    sticky: serializeAffinityMap(stickySessionBindings, nowMs),
    lastSuccess: serializeLastSuccessMap(lastSuccessByModelKey),
  };
}

async function loadProxyChannelAffinityFromSettings(): Promise<void> {
  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, PROXY_CHANNEL_AFFINITY_SETTING_KEY))
    .get();
  if (!row?.value) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const record = parsed as Record<string, unknown>;
  const nowMs = Date.now();
  hydrateAffinityMap(stickySessionBindings, record.sticky, nowMs);
  hydrateLastSuccessMap(lastSuccessByModelKey, record.lastSuccess);
}

export async function ensureProxyChannelAffinityLoaded(): Promise<void> {
  if (affinityLoaded) return;
  if (affinityLoadPromise) {
    await affinityLoadPromise;
    return;
  }
  const loadTask = (async () => {
    try {
      await loadProxyChannelAffinityFromSettings();
    } catch (error) {
      console.warn(
        `[proxyChannelCoordinator] failed to load affinity state: ${(error as Error)?.message || 'unknown error'}`,
      );
    } finally {
      affinityLoaded = true;
      affinityLoadPromise = null;
    }
  })();
  affinityLoadPromise = loadTask;
  await loadTask;
}

export async function persistProxyChannelAffinityState(): Promise<void> {
  if (affinityPersistInFlight) {
    await affinityPersistInFlight;
    return;
  }

  const persistTask = (async () => {
    try {
      const payload = buildAffinityPersistencePayload();
      await upsertSetting(PROXY_CHANNEL_AFFINITY_SETTING_KEY, payload);
    } catch (error) {
      console.warn(
        `[proxyChannelCoordinator] failed to persist affinity state: ${(error as Error)?.message || 'unknown error'}`,
      );
    }
  })();

  affinityPersistInFlight = persistTask;
  try {
    await persistTask;
  } finally {
    if (affinityPersistInFlight === persistTask) {
      affinityPersistInFlight = null;
    }
  }
}

function scheduleProxyChannelAffinityPersistence(): void {
  if (affinitySaveTimer) return;
  affinitySaveTimer = setTimeout(() => {
    affinitySaveTimer = null;
    void persistProxyChannelAffinityState();
  }, PROXY_CHANNEL_AFFINITY_PERSIST_DEBOUNCE_MS);
  shouldUnrefTimer(affinitySaveTimer);
}

class ProxyChannelCoordinator {
  buildStickySessionKey(input: {
    clientKind?: string | null;
    sessionId?: string | null;
    requestedModel?: string | null;
    downstreamPath?: string | null;
    downstreamApiKeyId?: number | null;
  }): string | null {
    if (!config.proxyStickySessionEnabled) return null;
    const requestedModel = String(input.requestedModel || '').trim().toLowerCase();
    if (!requestedModel) return null;
    const downstreamPath = String(input.downstreamPath || '').trim().toLowerCase() || 'unknown';
    const clientKind = String(input.clientKind || 'generic').trim().toLowerCase() || 'generic';
    const owner = typeof input.downstreamApiKeyId === 'number' && Number.isFinite(input.downstreamApiKeyId)
      ? `key:${Math.trunc(input.downstreamApiKeyId)}`
      : 'key:anonymous';
    // Prefer real client session when present. Without it, still keep a soft affinity
    // key so successful free/API routes stick across consecutive turns of the same
    // key+model (personal hubs otherwise re-roll every request).
    const sessionId = String(input.sessionId || '').trim() || 'soft';
    return [owner, clientKind, downstreamPath, requestedModel, sessionId].join('|');
  }

  getStickyChannelId(stickySessionKey?: string | null, nowMs = Date.now()): number | null {
    cleanupExpiredStickyBindings(nowMs);
    const normalizedKey = String(stickySessionKey || '').trim();
    if (!normalizedKey) return null;
    const entry = stickySessionBindings.get(normalizedKey);
    if (!entry || entry.expiresAtMs <= nowMs) {
      stickySessionBindings.delete(normalizedKey);
      return null;
    }
    return entry.channelId;
  }

  bindStickyChannel(stickySessionKey: string | null | undefined, channelId: number, _accountIdentity?: SessionScopedChannelInput): void {
    if (!config.proxyStickySessionEnabled) return;
    // Sticky preference applies to every channel type (API key + OAuth).
    // Concurrency leases remain session-scoped only — sticky here is pure routing memory
    // so a just-working free/API site is not abandoned on the next turn.
    void _accountIdentity;
    const normalizedKey = String(stickySessionKey || '').trim();
    if (!normalizedKey || !Number.isFinite(channelId) || channelId <= 0) return;
    cleanupExpiredStickyBindings();
    const previous = stickySessionBindings.get(normalizedKey);
    touchAffinityEntry(stickySessionBindings, normalizedKey, {
      channelId: Math.trunc(channelId),
      expiresAtMs: Date.now() + getStickySessionTtlMs(),
      // Successful sticky dispatch refreshes TTL after every turn; preserve its
      // hit count when the channel has not changed so the cap can take effect.
      hitCount: previous?.channelId === Math.trunc(channelId) ? (previous.hitCount ?? 0) : 0,
    });
    scheduleProxyChannelAffinityPersistence();
  }

  clearStickyChannel(stickySessionKey?: string | null, channelId?: number | null): void {
    const normalizedKey = String(stickySessionKey || '').trim();
    if (!normalizedKey) return;
    const existing = stickySessionBindings.get(normalizedKey);
    if (!existing) return;
    if (typeof channelId === 'number' && Number.isFinite(channelId) && existing.channelId !== Math.trunc(channelId)) {
      return;
    }
    stickySessionBindings.delete(normalizedKey);
    scheduleProxyChannelAffinityPersistence();
  }

  /**
   * Model-level last-success affinity (key + model), independent of client session/path.
   * Prefer this on the next primary hop when sticky is missing or stale.
   */
  getLastSuccessChannelId(input: {
    requestedModel?: string | null;
    downstreamApiKeyId?: number | null;
  }): number | null {
    const key = buildLastSuccessKey(input);
    if (!key) return null;
    // Event-driven lifetime: entries are not time-expired. They survive until
    // the hit-count cap rebalances traffic or a failure cooldown clears them.
    const entry = lastSuccessByModelKey.get(key);
    if (!entry) return null;
    return entry.channelId;
  }

  rememberLastSuccessChannel(input: {
    requestedModel?: string | null;
    downstreamApiKeyId?: number | null;
    channelId: number;
  }): void {
    // Model-level last-success affinity is an independent safety net from the
    // session-level sticky binding. It must keep recording successes even when
    // PROXY_STICKY_SESSION_ENABLED is off — otherwise the fallback-to-last-good
    // guarantee silently dies the moment sticky sessions are disabled, while
    // the read side (getLastSuccessChannelId) never checks that flag.
    const key = buildLastSuccessKey(input);
    const channelId = Math.trunc(input.channelId || 0);
    if (!key || channelId <= 0) return;
    cleanupExpiredStickyBindings();
    const previous = lastSuccessByModelKey.get(key);
    touchAffinityEntry(lastSuccessByModelKey, key, {
      channelId,
      lastSuccessAtMs: Date.now(),
      hitCount: previous?.channelId === channelId ? (previous.hitCount ?? 0) : 0,
    });
    scheduleProxyChannelAffinityPersistence();
  }

  clearLastSuccessChannel(input: {
    requestedModel?: string | null;
    downstreamApiKeyId?: number | null;
    channelId?: number | null;
  }): void {
    const key = buildLastSuccessKey(input);
    if (!key) return;
    const existing = lastSuccessByModelKey.get(key);
    if (!existing) return;
    if (typeof input.channelId === 'number' && Number.isFinite(input.channelId)
      && existing.channelId !== Math.trunc(input.channelId)) {
      return;
    }
    lastSuccessByModelKey.delete(key);
    scheduleProxyChannelAffinityPersistence();
  }

  /**
   * Increment the consecutive-hit counter for a live sticky binding.
   * Returns the new hit count (0 when no binding exists). The caller drops the
   * binding when the count exceeds the configured max hits, so dense same-key
   * traffic re-enters balanced-v2 instead of monopolizing one site.
   */
  incrementStickyHitCount(stickySessionKey?: string | null): number {
    const normalizedKey = String(stickySessionKey || '').trim();
    if (!normalizedKey) return 0;
    const entry = stickySessionBindings.get(normalizedKey);
    if (!entry) return 0;
    entry.hitCount = Math.max(0, (entry.hitCount ?? 0)) + 1;
    scheduleProxyChannelAffinityPersistence();
    return entry.hitCount;
  }

  /**
   * Consume one last-success preference opportunity. Returns true when the
   * caller should explore balanced-v2 instead of using the preferred channel.
   * The old preference remains intact if exploration fails; a later request can
   * still use it as a fallback.
   */
  shouldExploreFromLastSuccess(input: {
    requestedModel?: string | null;
    downstreamApiKeyId?: number | null;
    explorationInterval: number;
  }): boolean {
    const key = buildLastSuccessKey(input);
    if (!key) return false;
    const entry = lastSuccessByModelKey.get(key);
    if (!entry) return false;
    const interval = Math.max(1, Math.trunc(input.explorationInterval || 1));
    const hitCount = Math.max(0, entry.hitCount ?? 0);
    if (hitCount + 1 >= interval) {
      entry.hitCount = 0;
      scheduleProxyChannelAffinityPersistence();
      return true;
    }
    entry.hitCount = hitCount + 1;
    scheduleProxyChannelAffinityPersistence();
    return false;
  }

  getActiveChannelIds(): number[] {
    const ids: number[] = [];
    for (const [channelId, state] of channelRuntimeStates.entries()) {
      pruneCancelledWaiters(state);
      if (state.activeLeaseIds.size > 0) {
        ids.push(channelId);
      }
    }
    return ids;
  }

  getChannelLoadSnapshot(input: {
    channelId: number;
    accountExtraConfig?: string | null;
    accountOauthProvider?: string | null;
  }): ProxyChannelLoadSnapshot {
    const channelId = Math.trunc(input.channelId || 0);
    const sessionScoped = isSessionScopedChannel({
      extraConfig: input.accountExtraConfig,
      oauthProvider: input.accountOauthProvider,
    });
    const concurrencyLimit = getChannelConcurrencyLimit({
      extraConfig: input.accountExtraConfig,
      oauthProvider: input.accountOauthProvider,
    });
    const state = channelId > 0 ? channelRuntimeStates.get(channelId) : null;
    if (state) {
      pruneCancelledWaiters(state);
    }
    const activeLeaseCount = state?.activeLeaseIds.size ?? 0;
    const waitingCount = state?.queue.length ?? 0;
    const denominator = concurrencyLimit > 0 ? concurrencyLimit : 1;
    return {
      channelId,
      sessionScoped,
      concurrencyLimit,
      activeLeaseCount,
      waitingCount,
      loadRatio: (activeLeaseCount + waitingCount) / denominator,
      saturated: concurrencyLimit > 0 && activeLeaseCount >= concurrencyLimit,
    };
  }

  getChannelLoadSnapshots(input: Array<{
    channelId: number;
    accountExtraConfig?: string | null;
    accountOauthProvider?: string | null;
  }>): Map<number, ProxyChannelLoadSnapshot> {
    const snapshots = new Map<number, ProxyChannelLoadSnapshot>();
    for (const item of input) {
      const snapshot = this.getChannelLoadSnapshot(item);
      snapshots.set(snapshot.channelId, snapshot);
    }
    return snapshots;
  }

  async acquireChannelLease(input: {
    channelId: number;
    accountExtraConfig?: string | null;
    accountOauthProvider?: string | null;
  }): Promise<AcquireProxyChannelLeaseResult> {
    const channelId = Math.trunc(input.channelId || 0);
    if (channelId <= 0) {
      return {
        status: 'acquired',
        lease: createNoopLease(0),
      };
    }

    const concurrencyLimit = getChannelConcurrencyLimit({
      extraConfig: input.accountExtraConfig,
      oauthProvider: input.accountOauthProvider,
    });
    if (concurrencyLimit <= 0) {
      return {
        status: 'acquired',
        lease: createNoopLease(channelId),
      };
    }

    const state = getOrCreateChannelRuntimeState(channelId);
    pruneCancelledWaiters(state);
    if (state.activeLeaseIds.size < concurrencyLimit) {
      return {
        status: 'acquired',
        lease: this.createTrackedLease(channelId, state),
      };
    }

    const waitMs = getChannelQueueWaitMs();
    if (waitMs <= 0) {
      return {
        status: 'timeout',
        waitMs: 0,
      };
    }

    return await new Promise<AcquireProxyChannelLeaseResult>((resolve) => {
      const waiter: ChannelWaiter = {
        cancelled: false,
        resolve,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        waiter.cancelled = true;
        waiter.timer = null;
        pruneCancelledWaiters(state);
        maybeDeleteChannelRuntimeState(channelId);
        resolve({
          status: 'timeout',
          waitMs,
        });
      }, waitMs);
      shouldUnrefTimer(waiter.timer);
      state.queue.push(waiter);
    });
  }

  private createTrackedLease(channelId: number, state: ChannelRuntimeState): ProxyChannelLease {
    const leaseId = nextLeaseId++;
    state.activeLeaseIds.add(leaseId);

    let released = false;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    const release = () => {
      if (released) return;
      released = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      state.activeLeaseIds.delete(leaseId);
      this.drainQueue(channelId);
      maybeDeleteChannelRuntimeState(channelId);
    };

    const touch = () => {
      if (released) return;
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => {
        release();
      }, getChannelLeaseTtlMs());
      shouldUnrefTimer(expiryTimer);
    };

    touch();

    const keepaliveMs = getChannelLeaseKeepaliveMs();
    if (keepaliveMs > 0) {
      keepaliveTimer = setInterval(() => {
        touch();
      }, keepaliveMs);
      shouldUnrefTimer(keepaliveTimer);
    }

    return {
      channelId,
      isActive: () => !released,
      release,
      touch,
    };
  }

  private drainQueue(channelId: number): void {
    const state = channelRuntimeStates.get(channelId);
    if (!state) return;
    pruneCancelledWaiters(state);
    const concurrencyLimit = Math.max(0, Math.trunc(config.proxySessionChannelConcurrencyLimit || 0));
    while (state.activeLeaseIds.size < concurrencyLimit && state.queue.length > 0) {
      const waiter = state.queue.shift();
      if (!waiter || waiter.cancelled) continue;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.timer = null;
      waiter.resolve({
        status: 'acquired',
        lease: this.createTrackedLease(channelId, state),
      });
    }
  }
}

export function resetProxyChannelCoordinatorState(): void {
  stickySessionBindings.clear();
  lastSuccessByModelKey.clear();
  channelRuntimeStates.clear();
  nextLeaseId = 1;
  if (affinitySaveTimer) {
    clearTimeout(affinitySaveTimer);
    affinitySaveTimer = null;
  }
  // Tests/reset should not race a later settings reload unless explicitly re-enabled.
  affinityLoaded = true;
  affinityLoadPromise = null;
  affinityPersistInFlight = null;
}

/** Test helper: force next ensure() to reload from settings. */
export function markProxyChannelAffinityUnloadedForTests(): void {
  affinityLoaded = false;
  affinityLoadPromise = null;
}

export function isProxyChannelSessionScoped(input?: SessionScopedChannelInput): boolean {
  return isSessionScopedChannel(input);
}

export const proxyChannelCoordinator = new ProxyChannelCoordinator();
