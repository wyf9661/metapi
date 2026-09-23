import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import {
  ensureProxyChannelAffinityLoaded,
  markProxyChannelAffinityUnloadedForTests,
  proxyChannelCoordinator,
  resetProxyChannelCoordinatorState,
} from './proxyChannelCoordinator.js';

const settingsStore = new Map<string, string>();
const upsertSettingMock = vi.fn(async (key: string, value: unknown) => {
  settingsStore.set(key, JSON.stringify(value));
});

vi.mock('../db/upsertSetting.js', () => ({
  upsertSetting: (...args: unknown[]) => upsertSettingMock(...(args as [string, unknown])),
}));

const liveChannelIds = new Set<number>([501, 502]);
const selectCalls: string[] = [];

vi.mock('../db/index.js', () => ({
  db: {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        // The mocked schema passes plain objects (mock's schema.routeChannels),
        // real drizzle tables carry Symbol(drizzle:Name). Support both.
        const sym = Object.getOwnPropertySymbols(table || {}).find(
          (s) => String(s) === 'Symbol(drizzle:Name)',
        );
        const rawName = sym
          ? String((table as Record<PropertyKey, unknown>)[sym])
          : String((table as { name?: unknown })?.name ?? `unknown:${selectCalls.length}`);
        const tableName = rawName.startsWith('unknown:') ? rawName : rawName;
        if (!rawName.startsWith('unknown:')) {
          selectCalls.push(tableName);
        }
        return {
          where: () => ({
            get: async () => {
              const value = settingsStore.get('proxy_channel_affinity_v1');
              return value ? { value } : undefined;
            },
          }),
          all: async () => (tableName === 'route_channels'
            ? [...liveChannelIds].map((id) => ({ id }))
            : []),
        };
      },
    }),
  },
  schema: {
    settings: { key: 'key', value: 'value' },
    routeChannels: { id: 'id', name: 'route_channels' },
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: () => ({}),
}));

describe('proxyChannelCoordinator hydration hygiene', () => {
  const originalStickyEnabled = config.proxyStickySessionEnabled;
  const originalStickyTtlMs = config.proxyStickySessionTtlMs;

  beforeEach(() => {
    vi.useFakeTimers();
    config.proxyStickySessionEnabled = true;
    config.proxyStickySessionTtlMs = 31_000;
    settingsStore.clear();
    upsertSettingMock.mockClear();
    selectCalls.length = 0;
    liveChannelIds.clear();
    liveChannelIds.add(501);
    liveChannelIds.add(502);
    resetProxyChannelCoordinatorState();
  });

  afterEach(() => {
    config.proxyStickySessionEnabled = originalStickyEnabled;
    config.proxyStickySessionTtlMs = originalStickyTtlMs;
    resetProxyChannelCoordinatorState();
    vi.useRealTimers();
  });

  it('drops hydrated last-success entries whose channelId no longer exists', async () => {
    settingsStore.set(
      'proxy_channel_affinity_v1',
      JSON.stringify({
        version: 1,
        savedAtMs: Date.now(),
        sticky: {},
        lastSuccess: {
          'key:5|glm-5.3-flash': { channelId: 501, lastSuccessAtMs: Date.now() - 1000, hitCount: 1 },
          'key:5|zz-verify-empty-1': { channelId: 594671, lastSuccessAtMs: Date.now() - 1000, hitCount: 0 },
          'key:5|zz-verify-effort-1': { channelId: 594669, lastSuccessAtMs: Date.now() - 1000, hitCount: 0 },
        },
      }),
    );
    markProxyChannelAffinityUnloadedForTests();
    await ensureProxyChannelAffinityLoaded();
    console.log('selectCalls:', JSON.stringify(selectCalls));

    expect(selectCalls).toContain('route_channels');
    expect(proxyChannelCoordinator.getLastSuccessChannelId({
      requestedModel: 'glm-5.3-flash',
      downstreamApiKeyId: 5,
    })).toBe(501);
    expect(proxyChannelCoordinator.getLastSuccessChannelId({
      requestedModel: 'zz-verify-empty-1',
      downstreamApiKeyId: 5,
    })).toBeNull();
    expect(proxyChannelCoordinator.getLastSuccessChannelId({
      requestedModel: 'zz-verify-effort-1',
      downstreamApiKeyId: 5,
    })).toBeNull();
  });

  it('drops hydrated sticky bindings whose channelId no longer exists', async () => {
    settingsStore.set(
      'proxy_channel_affinity_v1',
      JSON.stringify({
        version: 1,
        savedAtMs: Date.now(),
        sticky: {
          'key:5|generic|/v1/chat/completions|gpt-5.2|sess-1': {
            channelId: 594998,
            expiresAtMs: Date.now() + 30_000,
            hitCount: 0,
          },
          'key:5|generic|/v1/chat/completions|gpt-5.2|sess-2': {
            channelId: 502,
            expiresAtMs: Date.now() + 30_000,
            hitCount: 0,
          },
        },
        lastSuccess: {},
      }),
    );
    markProxyChannelAffinityUnloadedForTests();
    await ensureProxyChannelAffinityLoaded();

    expect(proxyChannelCoordinator.getStickyChannelId(
      'key:5|generic|/v1/chat/completions|gpt-5.2|sess-1',
    )).toBeNull();
    expect(proxyChannelCoordinator.getStickyChannelId(
      'key:5|generic|/v1/chat/completions|gpt-5.2|sess-2',
    )).toBe(502);
  });
});
