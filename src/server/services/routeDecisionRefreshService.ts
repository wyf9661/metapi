import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { saveRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';
import { matchesModelPattern, tokenRouter } from './tokenRouter.js';
import { ROUTE_DECISION_REFRESH_TASK_TYPE } from '../../shared/tokenRouteContract.js';

export { ROUTE_DECISION_REFRESH_TASK_TYPE };
export const ROUTE_DECISION_REFRESH_DEDUPE_KEY = 'refresh-route-decision-snapshots';

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

// Shared in-flight guard so the periodic scheduler and a manual refresh never
// iterate the (potentially large) route set concurrently on the same SQLite DB.
// Without this, two simultaneous refreshes contend on the same token_routes
// write lock and each gets dragged out far beyond its natural duration.
let refreshInFlight: Promise<{
  exactModelCount: number;
  wildcardRouteCount: number;
  failureCount: number;
}> | null = null;

function normalizeModels(models: string[]): string[] {
  return Array.from(new Set(
    models
      .map((model) => String(model || '').trim())
      .filter(Boolean),
  ));
}

function normalizeRouteIds(routeIds: number[]): number[] {
  return Array.from(new Set(
    routeIds
      .map((routeId) => Math.trunc(routeId))
      .filter((routeId) => routeId > 0),
  ));
}

type RefreshOptions = {
  refreshPricingCatalog?: boolean;
  onProgress?: (message: string) => void;
};

// Serialize concurrent refreshes: the periodic scheduler and a manual refresh
// share this lock so they never iterate the full route set on the same SQLite
// DB at once. A later caller waits for the in-flight run to finish, then runs
// its own refresh so option differences (pricing catalog) are never dropped.
export async function refreshAllRouteDecisionSnapshots(options: RefreshOptions = {}): Promise<{
  exactModelCount: number;
  wildcardRouteCount: number;
  failureCount: number;
}> {
  const previous = refreshInFlight;
  if (previous) {
    try {
      await previous;
    } catch {
      // swallow: the earlier run failed for its own reasons; we still refresh.
    }
  }

  let run: Promise<{ exactModelCount: number; wildcardRouteCount: number; failureCount: number }>;
  run = (async () => {
    // Per-unit failures are collected rather than thrown: a single unevaluable
    // upstream expression used to abort the entire refresh run.
    const failures: Array<{ scope: string; message: string }> = [];
    const routes = await db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
    }).from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.enabled, true))
      .all();

    const exactModels = normalizeModels(
      routes
        .filter((route: any) => isExactModelPattern(route.modelPattern))
        .map((route: any) => route.modelPattern),
    );
    const wildcardRouteIds = normalizeRouteIds(
      routes
        .filter((route: any) => !isExactModelPattern(route.modelPattern))
        .map((route: any) => route.id),
    );
    const refreshedKeys = options.refreshPricingCatalog ? new Set<string>() : undefined;

    options.onProgress?.(`开始刷新路由概率：精确模型 ${exactModels.length}，通配符路由 ${wildcardRouteIds.length}`);

    for (const [index, model] of exactModels.entries()) {
      options.onProgress?.(`刷新精确模型概率 ${index + 1}/${exactModels.length}：${model}`);
      const matchingRoutes = routes.filter((route: any) => (
        isExactModelPattern(route.modelPattern) && matchesModelPattern(model, route.modelPattern)
      ));
      const snapshotWrites: Array<{ routeId: number; snapshot: unknown }> = [];
      for (const route of matchingRoutes) {
        try {
          if (options.refreshPricingCatalog) {
            await tokenRouter.refreshPricingReferenceCostsForRoute(route.id, model, { refreshedKeys });
          }
          const decision = await tokenRouter.explainSelectionForRoute(route.id, model);
          snapshotWrites.push({
            routeId: route.id,
            snapshot: decision,
          });
        } catch (error) {
          // One model whose upstream pricing expression this build cannot
          // evaluate must not abort the whole refresh: the previous run lost
          // snapshots for all 276 models because of a single ReferenceError.
          failures.push({
            scope: `model:${model}#route:${route.id}`,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (snapshotWrites.length > 0) {
        await saveRouteDecisionSnapshots(snapshotWrites);
      }
    }

    for (const [index, routeId] of wildcardRouteIds.entries()) {
      options.onProgress?.(`刷新通配符路由概率 ${index + 1}/${wildcardRouteIds.length}：#${routeId}`);
      try {
        if (options.refreshPricingCatalog) {
          await tokenRouter.refreshRouteWidePricingReferenceCosts(routeId, { refreshedKeys });
        }

        const decision = await tokenRouter.explainSelectionRouteWide(routeId);
        await saveRouteDecisionSnapshots([
          {
            routeId,
            snapshot: decision,
          },
        ]);
      } catch (error) {
        failures.push({
          scope: `wildcard-route:${routeId}`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (failures.length > 0) {
      // Surface every skipped unit so a silent regression (one broken upstream
      // expression quietly stopping part of the refresh) stays visible.
      for (const failure of failures) {
        options.onProgress?.(`跳过 ${failure.scope}：${failure.message}`);
      }
      console.warn(
        `[RouteDecisionRefresh] ${failures.length} unit(s) skipped: `
        + failures.map((failure) => `${failure.scope} -> ${failure.message}`).join('; '),
      );
    }

    return {
      exactModelCount: exactModels.length,
      wildcardRouteCount: wildcardRouteIds.length,
      failureCount: failures.length,
    };
  })().finally(() => {
    if (refreshInFlight === run) refreshInFlight = null;
  });

  refreshInFlight = run;
  return run;
}
