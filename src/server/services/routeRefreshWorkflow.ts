import {
  rebuildTokenRoutesFromAvailability,
  refreshModelsAndRebuildRoutes as refreshModelsAndRebuildRoutesViaModelService,
} from './modelService.js';

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

export async function refreshModelsAndRebuildRoutesBounded(
  timeoutMs: number = REQUEST_PATH_REFRESH_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await Promise.race([
      refreshModelsAndRebuildRoutes(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`route refresh exceeded ${timeoutMs}ms (request path)`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
    return true;
  } catch (error) {
    console.warn(
      '[route-refresh] bounded refresh failed or timed out:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

