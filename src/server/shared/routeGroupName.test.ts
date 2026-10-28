import { describe, expect, it } from 'vitest';
import {
  buildGroupOwnershipMap,
  canonicalRouteAlias,
  collectGroupNameOwners,
  findGroupNameConflict,
  resolveExposedRouteName,
  type GroupNameRouteLike,
} from './routeGroupName.js';

const g = (over: Partial<GroupNameRouteLike> & { id: number }): GroupNameRouteLike => ({
  modelPattern: '',
  displayName: null,
  routeMode: 'pattern',
  enabled: true,
  sourceRouteIds: [],
  ...over,
});

describe('routeGroupName shared rules', () => {
  it('exposes displayName over modelPattern', () => {
    expect(resolveExposedRouteName(g({ id: 1, displayName: '  Opus ', modelPattern: 'x' }))).toBe('Opus');
    expect(resolveExposedRouteName(g({ id: 1, modelPattern: 'x' }))).toBe('x');
  });

  it('canonicalizes aliases the way the router matches them', () => {
    expect(canonicalRouteAlias('z-ai/Merged-X:free')).toBe(canonicalRouteAlias('Merged-X'));
    expect(canonicalRouteAlias('  DeepSeek-V4.1-Flash ')).toBe('deepseek-v4.1-flash');
  });

  it('blocks only enabled groups with sources', () => {
    const routes = [
      g({ id: 10, routeMode: 'explicit_group', displayName: 'Merged-X', sourceRouteIds: [1, 2] }),
      g({ id: 11, routeMode: 'explicit_group', displayName: 'Merged-X', sourceRouteIds: [] }),
      g({ id: 12, routeMode: 'explicit_group', displayName: 'Merged-X', sourceRouteIds: [1], enabled: false }),
      g({ id: 1, modelPattern: 'Merged-X' }),
    ];
    const owners = collectGroupNameOwners(routes);
    expect(owners.map((r) => r.id)).toEqual([10]);

    const conflict = findGroupNameConflict(routes, 'merged-x', null);
    expect(conflict.blockingGroup?.id).toBe(10);
    expect(conflict.sameAliasRoutes.map((r) => r.id).sort()).toEqual([1, 11, 12]);

    // editing the owner itself never conflicts with itself
    const self = findGroupNameConflict(routes, 'Merged-X', 10);
    expect(self.blockingGroup).toBeNull();
  });

  it('ownership map points sources at their groups', () => {
    const routes = [
      g({ id: 10, routeMode: 'explicit_group', displayName: 'G', sourceRouteIds: [1, 2] }),
      g({ id: 11, routeMode: 'explicit_group', displayName: 'H', sourceRouteIds: [2] }),
      g({ id: 1, modelPattern: 'a' }),
    ];
    const map = buildGroupOwnershipMap(routes);
    expect([...map.keys()].sort()).toEqual([1, 2]);
    expect(map.get(2)!.map((r) => r.id)).toEqual([10, 11]);
  });
});
