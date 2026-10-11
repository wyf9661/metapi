import {
  rebuildTokenRoutesFromAvailability,
  refreshModelsAndRebuildRoutes as refreshModelsAndRebuildRoutesViaModelService,
} from './modelService.js';
import { sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export async function rebuildRoutesOnly() {
  return rebuildTokenRoutesFromAvailability();
}

export async function rebuildRoutesBestEffort() {
  try {
    await rebuildRoutesOnly();
    return true;
  } catch {
    return false;
  }
}

export async function refreshModelsAndRebuildRoutes() {
  return refreshModelsAndRebuildRoutesViaModelService();
}

// Request-path safety bound: a refresh triggered from a live proxy request
// must never hold client traffic hostage. A wedged pass (an unwrapped upstream
// fetch) once kept this promise pending for 15h; every request that reached
// the empty-selection refresh path hung with it (2026-09-12, peer site on a
// troubled tunnel). Request paths use this bounded variant instead.
export const REQUEST_PATH_REFRESH_TIMEOUT_MS = 15_000;

function raceWithTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

export async function refreshModelsAndRebuildRoutesBounded(
  timeoutMs: number = REQUEST_PATH_REFRESH_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await raceWithTimeout(
      refreshModelsAndRebuildRoutes(),
      timeoutMs,
      `route refresh exceeded ${timeoutMs}ms (request path)`,
    );
    return true;
  } catch (error) {
    console.warn(
      '[route-refresh] bounded refresh failed or timed out:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Scheduled passes may take longer than a request-path refresh, but they must
 * still land. The 30-minute model-refresh cron awaited the unbounded pass, so a
 * management call that never settled kept that pass reporting failure for 18h
 * until a manual restart (2026-09-28), with no way to tell "upstream said no"
 * from "the pass never finished". The scheduler uses this bound and logs which
 * of the two happened.
 */
export const SCHEDULER_REFRESH_TIMEOUT_MS = 120_000;

// The scheduled pass processes accounts serially: each account can spend up
// to its 10 s upstream timeout plus pacing, so a fixed bound stops fitting
// once the deployment grows (2026-10-10: 249 accounts, every scheduled pass
// reported "did not complete" although the pass was healthy). Scale the bound
// with the account count instead: 12 s per account, floor 120 s, ceiling 1 h.
const SCHEDULER_REFRESH_MS_PER_ACCOUNT = 12_000;
const SCHEDULER_REFRESH_MAX_TIMEOUT_MS = 3_600_000;

export function computeSchedulerRefreshTimeoutMs(accountCount: number): number {
  const scaled = accountCount * SCHEDULER_REFRESH_MS_PER_ACCOUNT;
  return Math.max(
    SCHEDULER_REFRESH_TIMEOUT_MS,
    Math.min(SCHEDULER_REFRESH_MAX_TIMEOUT_MS, Math.floor(scaled)),
  );
}

async function resolveSchedulerRefreshTimeoutMs(): Promise<number> {
  try {
    const rows = await db
      .select({ total: sql<number>`count(*)` })
      .from(schema.accounts)
      .all();
    const count = Number((rows?.[0] as { total?: unknown } | undefined)?.total ?? 0) || 0;
    return computeSchedulerRefreshTimeoutMs(count);
  } catch {
    return SCHEDULER_REFRESH_TIMEOUT_MS;
  }
}

export type ScheduledRefreshOutcome = {
  completed: boolean;
  result?: Awaited<ReturnType<typeof refreshModelsAndRebuildRoutes>>;
};

export async function refreshModelsAndRebuildRoutesWithSchedulerBound(
  timeoutMs?: number,
): Promise<ScheduledRefreshOutcome> {
  const boundMs = timeoutMs ?? (await resolveSchedulerRefreshTimeoutMs());
  try {
    const result = await raceWithTimeout(
      refreshModelsAndRebuildRoutes(),
      boundMs,
      `route refresh exceeded ${boundMs}ms (scheduler pass)`,
    );
    return { completed: true, result };
  } catch (error) {
    console.warn(
      '[route-refresh] scheduled refresh did not complete within its bound:',
      error instanceof Error ? error.message : String(error),
    );
    return { completed: false };
  }
}

