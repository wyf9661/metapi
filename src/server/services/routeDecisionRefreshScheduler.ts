import { refreshAllRouteDecisionSnapshots } from './routeDecisionRefreshService.js';

export const ROUTE_DECISION_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const ROUTE_DECISION_REFRESH_STARTUP_DELAY_MS = 5_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight: Promise<void> | null = null;

export async function refreshRouteDecisionSnapshotsOnce(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshAllRouteDecisionSnapshots({
    // Pricing is cached and refreshed elsewhere; scheduled snapshots should stay light.
    refreshPricingCatalog: false,
  }).then((result) => {
    console.info(
      `[RouteDecisionScheduler] refreshed exact=${result.exactModelCount} wildcard=${result.wildcardRouteCount}`,
    );
  }).catch((error) => {
    console.warn(
      `[RouteDecisionScheduler] refresh failed: ${error instanceof Error ? error.message : String(error || 'unknown error')}`,
    );
  }).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export function startRouteDecisionRefreshScheduler(
  intervalMs = ROUTE_DECISION_REFRESH_INTERVAL_MS,
  startupDelayMs = ROUTE_DECISION_REFRESH_STARTUP_DELAY_MS,
): void {
  stopRouteDecisionRefreshScheduler();
  startupTimer = setTimeout(() => {
    startupTimer = null;
    void refreshRouteDecisionSnapshotsOnce();
  }, Math.max(0, startupDelayMs));
  startupTimer.unref?.();

  refreshTimer = setInterval(() => {
    void refreshRouteDecisionSnapshotsOnce();
  }, Math.max(1_000, intervalMs));
  refreshTimer.unref?.();
}

export function stopRouteDecisionRefreshScheduler(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export async function __resetRouteDecisionRefreshSchedulerForTests(): Promise<void> {
  stopRouteDecisionRefreshScheduler();
  if (refreshInFlight) await refreshInFlight;
  refreshInFlight = null;
}
