import { canonicalizeModelName } from './modelCanonicalization.js';

/**
 * Group-name ownership rules, shared by the route editor UI and the
 * /api/routes guard so what the dialog warns about and what the API rejects
 * can never drift apart (the repo has been bitten by exactly this before).
 *
 * An explicit group "owns" its exposed name only while it is enabled AND has
 * at least one source binding: a group whose sources all died upstream must not
 * orphan the model name — rebuild then recreates the plain exact route and the
 * group shows as an empty shell the UI can point at.
 */

export type GroupNameRouteLike = {
  id: number;
  modelPattern?: string | null;
  displayName?: string | null;
  routeMode?: string | null;
  enabled?: boolean | null;
  sourceRouteIds?: number[] | null;
};

export function isExplicitGroupRouteLike(route: Pick<GroupNameRouteLike, 'routeMode'>): boolean {
  // Stored rows only ever carry 'pattern' | 'explicit_group' (normalized at
  // write time); anything else is a legacy NULL and behaves as 'pattern'.
  return route.routeMode === 'explicit_group';
}

/** The name clients request: displayName falls back to modelPattern. */
export function resolveExposedRouteName(route: Pick<GroupNameRouteLike, 'displayName' | 'modelPattern'>): string {
  const displayName = (route.displayName || '').trim();
  return displayName || (route.modelPattern || '').trim();
}

/**
 * Alias identity the router itself uses: canonicalize (strip vendor prefix,
 * :free/:latest, snapshot labels — see modelCanonicalization.ts) then lower.
 * Two names equal under this are the SAME public model to /v1/chat.
 */
export function canonicalRouteAlias(name: string | null | undefined): string {
  return (canonicalizeModelName(name || '') || '').trim().toLowerCase();
}

/** Enabled groups that currently own a public name (with sources). */
export function collectGroupNameOwners<T extends GroupNameRouteLike>(routes: T[]): T[] {
  return routes.filter((route) => (
    isExplicitGroupRouteLike(route)
    && !!route.enabled
    && Array.isArray(route.sourceRouteIds)
    && route.sourceRouteIds.length > 0
  ));
}

export type GroupNameConflict<T> = {
  /** Another ENABLED group owns the name: creating a second one is refused. */
  blockingGroup: T | null;
  /** Same-alias rows that are not blocking groups (exact routes, disabled groups). */
  sameAliasRoutes: T[];
};

/**
 * Conflict lookup for the editor + API guard. Same-alias exact routes are NOT
 * a rejection: folding a same-name exact route into the group is the normal
 * merge shape (group #19047 owns 'deepseek-v4.1-flash' with exact #11970 as a
 * source). Only group-over-group name collisions block.
 */
export function findGroupNameConflict<T extends GroupNameRouteLike>(
  routes: T[],
  exposedName: string,
  editingRouteId: number | null,
): GroupNameConflict<T> {
  const target = canonicalRouteAlias(exposedName);
  if (!target) return { blockingGroup: null, sameAliasRoutes: [] };

  let blockingGroup: T | null = null;
  const sameAliasRoutes: T[] = [];
  for (const route of routes) {
    if (editingRouteId != null && route.id === editingRouteId) continue;
    if (canonicalRouteAlias(resolveExposedRouteName(route)) !== target) continue;
    if (isExplicitGroupRouteLike(route) && route.enabled
      && (route.sourceRouteIds || []).length > 0 && !blockingGroup) {
      blockingGroup = route;
      continue;
    }
    sameAliasRoutes.push(route);
  }
  return { blockingGroup, sameAliasRoutes };
}

/** sourceRouteId -> groups that already list it. Badge data for the picker. */
export function buildGroupOwnershipMap<T extends GroupNameRouteLike>(routes: T[]): Map<number, T[]> {
  const owners = new Map<number, T[]>();
  for (const route of routes) {
    if (!isExplicitGroupRouteLike(route)) continue;
    for (const sourceRouteId of route.sourceRouteIds || []) {
      const list = owners.get(sourceRouteId);
      if (list) list.push(route);
      else owners.set(sourceRouteId, [route]);
    }
  }
  return owners;
}
