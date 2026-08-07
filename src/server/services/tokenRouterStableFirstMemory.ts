/**
 * Stable-first routing memory: module-level rotation/observation state for
 * the token router. Extracted from tokenRouter.ts — pure move, zero behavior
 * change. All state lives here so the routing engine file stays focused on
 * selection logic.
 */
import { setTokenRouterRuntimeHealthResetHook } from './tokenRouterRuntimeHealthStore.js';

export type StableFirstObservationProgressState = {
  requestCount: number;
  lastObservationAtMs: number | null;
};

const stableFirstLastSelectedSiteByKey = new Map<string, number>();
export const MAX_STABLE_FIRST_ROTATION_KEYS = 1024;
const stableFirstObservationProgressByKey = new Map<string, StableFirstObservationProgressState>();
const stableFirstObservationSiteCooldownByKey = new Map<string, number>();
export const MAX_STABLE_FIRST_OBSERVATION_PROGRESS_KEYS = 1024;
export const MAX_STABLE_FIRST_OBSERVATION_SITE_COOLDOWN_KEYS = 4096;

setTokenRouterRuntimeHealthResetHook(() => {
  stableFirstObservationProgressByKey.clear();
  stableFirstObservationSiteCooldownByKey.clear();
});

export function getStableFirstLastSelectedSiteByKey(): Map<string, number> {
  return stableFirstLastSelectedSiteByKey;
}

export function getStableFirstObservationProgressByKey(): Map<string, StableFirstObservationProgressState> {
  return stableFirstObservationProgressByKey;
}

export function getStableFirstObservationSiteCooldownByKey(): Map<string, number> {
  return stableFirstObservationSiteCooldownByKey;
}

export function rememberStableFirstSiteSelectionForKey(rotationKey: string, siteId: number): void {
  if (!rotationKey || !Number.isFinite(siteId) || siteId <= 0) return;
  if (stableFirstLastSelectedSiteByKey.has(rotationKey)) {
    stableFirstLastSelectedSiteByKey.delete(rotationKey);
  }
  stableFirstLastSelectedSiteByKey.set(rotationKey, siteId);
  while (stableFirstLastSelectedSiteByKey.size > MAX_STABLE_FIRST_ROTATION_KEYS) {
    const oldestKey = stableFirstLastSelectedSiteByKey.keys().next().value;
    if (!oldestKey) break;
    stableFirstLastSelectedSiteByKey.delete(oldestKey);
  }
}

export function rememberStableFirstObservationProgressForKey(
  rotationKey: string,
  state: StableFirstObservationProgressState,
): void {
  if (!rotationKey) return;
  if (stableFirstObservationProgressByKey.has(rotationKey)) {
    stableFirstObservationProgressByKey.delete(rotationKey);
  }
  stableFirstObservationProgressByKey.set(rotationKey, state);
  while (stableFirstObservationProgressByKey.size > MAX_STABLE_FIRST_OBSERVATION_PROGRESS_KEYS) {
    const oldestKey = stableFirstObservationProgressByKey.keys().next().value;
    if (!oldestKey) break;
    stableFirstObservationProgressByKey.delete(oldestKey);
  }
}

export function rememberStableFirstObservationSiteCooldown(
  rotationKey: string,
  siteId: number,
  observedAtMs: number,
): void {
  if (!rotationKey || !Number.isFinite(siteId) || siteId <= 0) return;
  const scopedKey = `${rotationKey}:${siteId}`;
  if (stableFirstObservationSiteCooldownByKey.has(scopedKey)) {
    stableFirstObservationSiteCooldownByKey.delete(scopedKey);
  }
  stableFirstObservationSiteCooldownByKey.set(scopedKey, observedAtMs);
  while (stableFirstObservationSiteCooldownByKey.size > MAX_STABLE_FIRST_OBSERVATION_SITE_COOLDOWN_KEYS) {
    const oldestKey = stableFirstObservationSiteCooldownByKey.keys().next().value;
    if (!oldestKey) break;
    stableFirstObservationSiteCooldownByKey.delete(oldestKey);
  }
}
