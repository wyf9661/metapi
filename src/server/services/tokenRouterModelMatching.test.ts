import { describe, expect, it } from 'vitest';
import {
  buildVisibleEnabledRoutes,
  channelSupportsRequestedModel,
  isModelAllowedByDownstreamPolicy,
  resolveActualModelForSelectedChannel,
  resolveMappedModel,
} from './tokenRouterModelMatching.js';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY } from './downstreamPolicyTypes.js';

describe('tokenRouterModelMatching', () => {
  it('resolves exact and pattern model mappings', () => {
    expect(resolveMappedModel('claude-sonnet-4-6', {
      'claude-sonnet-4-6': 'claude-sonnet-4-20250514',
    })).toBe('claude-sonnet-4-20250514');
    expect(resolveMappedModel('claude-sonnet-4-7', {
      'claude-sonnet-4-*': 'claude-sonnet-4-20250514',
    })).toBe('claude-sonnet-4-20250514');
    expect(resolveMappedModel('gpt-4o', { 'claude-*': 'x' })).toBe('gpt-4o');
  });

  it('accepts alias-equivalent channel source models', () => {
    expect(channelSupportsRequestedModel('Claude-Sonnet-4', 'claude-sonnet-4')).toBe(true);
    expect(channelSupportsRequestedModel('gpt-4o-mini', 'claude-sonnet-4')).toBe(false);
    expect(channelSupportsRequestedModel(null, 'anything')).toBe(true);
  });

  it('hides exact routes covered by custom display groups', () => {
    const routes = buildVisibleEnabledRoutes([
      {
        id: 1,
        enabled: true,
        routeMode: 'pattern',
        modelPattern: 'claude-sonnet-4',
        displayName: null,
        sourceRouteIds: [],
      },
      {
        id: 2,
        enabled: true,
        routeMode: 'pattern',
        modelPattern: 'claude-*',
        displayName: 'Claude Family',
        sourceRouteIds: [],
      },
    ]);
    expect(routes.map((route) => route.id)).toEqual([2]);
  });

  it('allows models via downstream supported patterns', () => {
    expect(isModelAllowedByDownstreamPolicy('gpt-4o', {
      ...EMPTY_DOWNSTREAM_ROUTING_POLICY,
      supportedModels: ['gpt-*'],
    })).toBe(true);
    expect(isModelAllowedByDownstreamPolicy('claude-sonnet-4', {
      ...EMPTY_DOWNSTREAM_ROUTING_POLICY,
      supportedModels: ['gpt-*'],
      denyAllWhenEmpty: true,
    })).toBe(false);
  });

  it('prefers channel source model when alias matches mapping', () => {
    expect(resolveActualModelForSelectedChannel(
      'Claude Sonnet',
      { displayName: 'Claude Sonnet' },
      'claude-sonnet-4',
      'Claude-Sonnet-4',
    )).toBe('Claude-Sonnet-4');
  });
});
