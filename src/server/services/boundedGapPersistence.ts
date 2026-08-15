import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import type { BoundedGapState } from './boundedGapSelection.js';

/**
 * Persistence for the bounded-gap routing state.
 *
 * The in-memory `sequence` / `lastSelectedSequence` pair must survive a
 * restart: if only `lastSelectedSequence` were restored with a fresh
 * `sequence`, the age (sequence - lastSelectedSequence) would be negative and
 * the site would never be considered due again — starving low-probability
 * sites. Restoring both values together keeps the gap accounting continuous
 * across restarts.
 *
 * Storage: the `settings` table (same mechanism as proxy-channel affinity),
 * which is dialect-agnostic, backed up with the rest of the DB, and safe to
 * drop if a future format change requires a reset.
 */

const BOUNDED_GAP_STATE_SETTING_KEY = 'routing.bounded_gap_states';
const BOUNDED_GAP_STATE_VERSION = 1;
const BOUNDED_GAP_PERSIST_DEBOUNCE_MS = 2_000;

type BoundedGapStatePersistencePayload = {
  version: number;
  savedAtMs: number;
  states: Record<string, BoundedGapState>;
};

let boundedGapStatesLoaded = false;
let boundedGapStatesLoadPromise: Promise<void> | null = null;
let boundedGapPersistTimer: ReturnType<typeof setTimeout> | null = null;
let boundedGapPersistInFlight: Promise<void> | null = null;

function shouldUnrefTimer(timer: ReturnType<typeof setTimeout>): void {
  try {
    timer.unref?.();
  } catch {
    // not fatal
  }
}

function serializeBoundedGapStates(nowMs = Date.now()): BoundedGapStatePersistencePayload {
  return {
    version: BOUNDED_GAP_STATE_VERSION,
    savedAtMs: nowMs,
    states: Object.fromEntries(boundedGapStateMap.entries()),
  };
}

/**
 * Load bounded-gap state from the settings table. Call once at startup before
 * routing begins. Any parse failure or unknown version falls back to an empty
 * state (same as a fresh process), never throwing into the router.
 */
export async function ensureBoundedGapStatesLoaded(): Promise<void> {
  if (boundedGapStatesLoaded) return;
  if (boundedGapStatesLoadPromise) {
    await boundedGapStatesLoadPromise;
    return;
  }
  const loadTask = (async () => {
    try {
      const row = await db.select({ value: schema.settings.value })
        .from(schema.settings)
        .where(eq(schema.settings.key, BOUNDED_GAP_STATE_SETTING_KEY))
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
      if (record.version !== BOUNDED_GAP_STATE_VERSION) return;
      const states = record.states;
      if (!states || typeof states !== 'object' || Array.isArray(states)) return;

      for (const [key, rawState] of Object.entries(states as Record<string, unknown>)) {
        if (!rawState || typeof rawState !== 'object') continue;
        const state = rawState as Record<string, unknown>;
        const sequence = typeof state.sequence === 'number' && Number.isFinite(state.sequence)
          ? Math.trunc(state.sequence)
          : null;
        const lastSelectedSequence = typeof state.lastSelectedSequence === 'number'
          && Number.isFinite(state.lastSelectedSequence)
          ? Math.trunc(state.lastSelectedSequence)
          : null;
        if (sequence == null) continue;
        boundedGapStateMap.set(key, {
          sequence,
          lastSelectedSequence,
        });
      }
    } catch (error) {
      console.warn(
        `[boundedGap] failed to load persisted state: ${error instanceof Error ? error.message : String(error || 'unknown')}`,
      );
    } finally {
      boundedGapStatesLoaded = true;
      boundedGapStatesLoadPromise = null;
    }
  })();
  boundedGapStatesLoadPromise = loadTask;
  await loadTask;
}

/**
 * Persist the current bounded-gap state (debounced). Called after every
 * selection; the debounce collapses bursts of routing traffic into a single
 * settings write. In-flight writes are coalesced so concurrent calls wait on
 * the same promise instead of stacking writes.
 */
export async function persistBoundedGapStates(): Promise<void> {
  if (boundedGapPersistInFlight) {
    await boundedGapPersistInFlight;
    return;
  }

  const persistTask = (async () => {
    try {
      await upsertSetting(BOUNDED_GAP_STATE_SETTING_KEY, serializeBoundedGapStates());
    } catch (error) {
      console.warn(
        `[boundedGap] failed to persist state: ${error instanceof Error ? error.message : String(error || 'unknown')}`,
      );
    }
  })();

  boundedGapPersistInFlight = persistTask;
  try {
    await persistTask;
  } finally {
    if (boundedGapPersistInFlight === persistTask) {
      boundedGapPersistInFlight = null;
    }
  }
}

function scheduleBoundedGapStatesPersist(): void {
  if (boundedGapPersistTimer) return;
  boundedGapPersistTimer = setTimeout(() => {
    boundedGapPersistTimer = null;
    void persistBoundedGapStates();
  }, BOUNDED_GAP_PERSIST_DEBOUNCE_MS);
  shouldUnrefTimer(boundedGapPersistTimer);
}

/**
 * Register the state map with the persistence layer and mark it dirty.
 * The map is owned by the token router; this module only reads/writes it.
 */
export function attachBoundedGapStateMap(map: Map<string, BoundedGapState>): void {
  boundedGapStateMap = map;
}

export function markBoundedGapStateDirty(): void {
  scheduleBoundedGapStatesPersist();
}

/** Test hook: reset module-level load/persist bookkeeping. */
export async function __resetBoundedGapPersistenceForTests(): Promise<void> {
  if (boundedGapPersistTimer) {
    clearTimeout(boundedGapPersistTimer);
    boundedGapPersistTimer = null;
  }
  if (boundedGapPersistInFlight) {
    await boundedGapPersistInFlight;
  }
  boundedGapStatesLoaded = false;
  boundedGapStatesLoadPromise = null;
}

let boundedGapStateMap: Map<string, BoundedGapState> = new Map();
