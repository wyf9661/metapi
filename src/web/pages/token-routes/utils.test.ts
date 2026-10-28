import { describe, expect, it, vi } from 'vitest';

vi.mock('../../components/BrandIcon.js', () => ({
  getBrand: () => null,
  normalizeBrandIconKey: (icon: string) => icon.trim().toLowerCase(),
}));

import {
  ROUTE_ICON_NONE_VALUE,
  normalizeRouteDisplayIconValue,
  resolveRouteIcon,
  routeKindRank,
} from './utils.js';

describe('token route icon helpers', () => {
  it('preserves the explicit no-icon sentinel during normalization', () => {
    expect(normalizeRouteDisplayIconValue(ROUTE_ICON_NONE_VALUE)).toBe(ROUTE_ICON_NONE_VALUE);
  });

  it('treats the explicit no-icon sentinel as no icon', () => {
    expect(resolveRouteIcon({ displayIcon: ROUTE_ICON_NONE_VALUE })).toEqual({ kind: 'none' });
  });
});

describe('route kind ordering', () => {
  it('sorts wildcard patterns first, then groups, then single exact models', () => {
    expect(routeKindRank({ modelPattern: '*', routeMode: 'pattern' })).toBe(0);
    expect(routeKindRank({ modelPattern: 're:^gpt-.*', routeMode: 'pattern' })).toBe(0);
    expect(routeKindRank({ modelPattern: 'my-group', routeMode: 'explicit_group' })).toBe(1);
    expect(routeKindRank({ modelPattern: 'gpt-5.5', routeMode: 'pattern' })).toBe(2);
  });
});
