import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import {
  ensureProxyChannelAffinityLoaded,
  markProxyChannelAffinityUnloadedForTests,
  persistProxyChannelAffinityState,
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

vi.mock('../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          get: async () => {
            const value = settingsStore.get('proxy_channel_affinity_v1');
            return value ? { value } : undefined;
          },
        }),
      }),
    }),
  },
  schema: {
    settings: {
      key: 'key',
      value: 'value',
    },
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: () => ({}),
}));

describe('proxyChannelCoordinator', () => {
  const originalStickyEnabled = config.proxyStickySessionEnabled;
  const originalStickyTtlMs = config.proxyStickySessionTtlMs;
  const originalConcurrencyLimit = config.proxySessionChannelConcurrencyLimit;
  const originalQueueWaitMs = config.proxySessionChannelQueueWaitMs;
  const originalLeaseTtlMs = config.proxySessionChannelLeaseTtlMs;
  const originalLeaseKeepaliveMs = config.proxySessionChannelLeaseKeepaliveMs;

  beforeEach(() => {
    vi.useFakeTimers();
    config.proxyStickySessionEnabled = true;
    config.proxyStickySessionTtlMs = 31_000;
    config.proxySessionChannelConcurrencyLimit = 1;
    config.proxySessionChannelQueueWaitMs = 200;
    config.proxySessionChannelLeaseTtlMs = 100;
    config.proxySessionChannelLeaseKeepaliveMs = 30;
    settingsStore.clear();
    upsertSettingMock.mockClear();
    resetProxyChannelCoordinatorState();
  });

  afterEach(() => {
    config.proxyStickySessionEnabled = originalStickyEnabled;
    config.proxyStickySessionTtlMs = originalStickyTtlMs;
    config.proxySessionChannelConcurrencyLimit = originalConcurrencyLimit;
    config.proxySessionChannelQueueWaitMs = originalQueueWaitMs;
    config.proxySessionChannelLeaseTtlMs = originalLeaseTtlMs;
    config.proxySessionChannelLeaseKeepaliveMs = originalLeaseKeepaliveMs;
    resetProxyChannelCoordinatorState();
    vi.useRealTimers();
  });

  it('stores sticky bindings for session-scoped channels and expires them by ttl', async () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-123',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    proxyChannelCoordinator.bindStickyChannel(key, 42, JSON.stringify({ credentialMode: 'session' }));
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(42);

    await vi.advanceTimersByTimeAsync(31_100);
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBeNull();
  });

  it('stores sticky bindings for apikey channels so successful free routes stick across turns', () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-456',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    proxyChannelCoordinator.bindStickyChannel(key, 42, JSON.stringify({ credentialMode: 'apikey' }));
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(42);
  });

  it('keeps soft sticky affinity when client has no session id', () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'generic',
      sessionId: null,
      requestedModel: 'grok-4.5',
      downstreamPath: '/v1/chat/completions',
      downstreamApiKeyId: 3,
    });
    expect(key).toContain('|soft');
    proxyChannelCoordinator.bindStickyChannel(key, 77, JSON.stringify({ credentialMode: 'apikey' }));
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(77);
  });

  it('remembers last-success channel by key+model independent of path/session', () => {
    proxyChannelCoordinator.rememberLastSuccessChannel({
      requestedModel: 'grok-4.5',
      downstreamApiKeyId: 3,
      channelId: 88,
    });
    expect(proxyChannelCoordinator.getLastSuccessChannelId({
      requestedModel: 'grok-4.5',
      downstreamApiKeyId: 3,
    })).toBe(88);
    // Different path/session sticky key must not be required for last-success.
    proxyChannelCoordinator.clearLastSuccessChannel({
      requestedModel: 'grok-4.5',
      downstreamApiKeyId: 3,
      channelId: 88,
    });
    expect(proxyChannelCoordinator.getLastSuccessChannelId({
      requestedModel: 'grok-4.5',
      downstreamApiKeyId: 3,
    })).toBeNull();
  });

  it('keeps last-success beyond any time window until explicitly cleared', () => {
    proxyChannelCoordinator.rememberLastSuccessChannel({
      requestedModel: 'kimi-k2',
      downstreamApiKeyId: 7,
      channelId: 77,
    });
    // Advancing well past the old 30s/5min TTL must NOT drop the binding:
    // last-success lifetime is event-driven (hit cap / failure cooldown),
    // not time-based.
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    expect(proxyChannelCoordinator.getLastSuccessChannelId({
      requestedModel: 'kimi-k2',
      downstreamApiKeyId: 7,
    })).toBe(77);
    proxyChannelCoordinator.clearLastSuccessChannel({
      requestedModel: 'kimi-k2',
      downstreamApiKeyId: 7,
      channelId: 77,
    });
    expect(proxyChannelCoordinator.getLastSuccessChannelId({
      requestedModel: 'kimi-k2',
      downstreamApiKeyId: 7,
    })).toBeNull();
  });

  it('persists sticky + last-success affinity and reloads after process-local reset', async () => {
    const stickyKey = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'generic',
      sessionId: 'sess-1',
      requestedModel: 'glm-5.2',
      downstreamPath: '/v1/chat/completions',
      downstreamApiKeyId: 2,
    });
    proxyChannelCoordinator.bindStickyChannel(stickyKey, 501, JSON.stringify({ credentialMode: 'apikey' }));
    proxyChannelCoordinator.rememberLastSuccessChannel({
      requestedModel: 'glm-5.2',
      downstreamApiKeyId: 2,
      channelId: 502,
    });

    await vi.advanceTimersByTimeAsync(600);
    await persistProxyChannelAffinityState();
    expect(upsertSettingMock).toHaveBeenCalled();
    expect(settingsStore.has('proxy_channel_affinity_v1')).toBe(true);

    resetProxyChannelCoordinatorState();
    expect(proxyChannelCoordinator.getStickyChannelId(stickyKey)).toBeNull();
    expect(proxyChannelCoordinator.getLastSuccessChannelId({
      requestedModel: 'glm-5.2',
      downstreamApiKeyId: 2,
    })).toBeNull();

    markProxyChannelAffinityUnloadedForTests();
    await ensureProxyChannelAffinityLoaded();

    expect(proxyChannelCoordinator.getStickyChannelId(stickyKey)).toBe(501);
    expect(proxyChannelCoordinator.getLastSuccessChannelId({
      requestedModel: 'glm-5.2',
      downstreamApiKeyId: 2,
    })).toBe(502);
  });

  it('hydrates legacy last-success rows persisted with expiresAtMs', async () => {
    // Simulate a settings row written by an older build (expiresAtMs field,
    // no lastSuccessAtMs). hydrateLastSuccessMap must accept it and fall back
    // to the current time as the sort key instead of dropping the entry.
    settingsStore.set(
      'proxy_channel_affinity_v1',
      JSON.stringify({
        version: 1,
        savedAtMs: Date.now(),
        sticky: {},
        lastSuccess: {
          'key:4|legacy-model': {
            channelId: 601,
            expiresAtMs: Date.now() + 30_000,
            hitCount: 2,
          },
        },
      }),
    );
    markProxyChannelAffinityUnloadedForTests();
    await ensureProxyChannelAffinityLoaded();

    expect(proxyChannelCoordinator.getLastSuccessChannelId({
      requestedModel: 'legacy-model',
      downstreamApiKeyId: 4,
    })).toBe(601);
  });

  it('treats structured oauth providers as session-scoped even when extraConfig omits oauth.provider', () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'turn-oauth-structured',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    proxyChannelCoordinator.bindStickyChannel(key, 42, {
      oauthProvider: 'codex',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(proxyChannelCoordinator.getStickyChannelId(key)).toBe(42);
  });

  it('queues requests behind the active lease and grants the next waiter after release', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    let secondSettled = false;
    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).then((result) => {
      secondSettled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(secondSettled).toBe(false);

    first.lease.release();
    await vi.advanceTimersByTimeAsync(0);

    const second = await secondPromise;
    expect(second.status).toBe('acquired');
    if (second.status === 'acquired') {
      second.lease.release();
    }
  });

  it('times out queued requests when no slot becomes available', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(secondPromise).resolves.toEqual({
      status: 'timeout',
      waitMs: 200,
    });

    first.lease.release();
  });

  it('keeps active leases alive until they are explicitly released', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    let secondSettled = false;
    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 11,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).then((result) => {
      secondSettled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(180);
    expect(first.lease.isActive()).toBe(true);
    expect(secondSettled).toBe(false);

    first.lease.release();
    await vi.advanceTimersByTimeAsync(0);

    const second = await secondPromise;
    expect(second.status).toBe('acquired');
    if (second.status === 'acquired') {
      second.lease.release();
    }
  });

  it('exposes the set of currently active leased channels', async () => {
    const lease = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 23,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(lease.status).toBe('acquired');
    if (lease.status !== 'acquired') return;

    expect(proxyChannelCoordinator.getActiveChannelIds()).toEqual([23]);

    lease.lease.release();
    expect(proxyChannelCoordinator.getActiveChannelIds()).toEqual([]);
  });

  it('reports active and waiting load for a guarded session channel', async () => {
    const first = await proxyChannelCoordinator.acquireChannelLease({
      channelId: 31,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    expect(first.status).toBe('acquired');
    if (first.status !== 'acquired') return;

    const secondPromise = proxyChannelCoordinator.acquireChannelLease({
      channelId: 31,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(proxyChannelCoordinator.getChannelLoadSnapshot({
      channelId: 31,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
    })).toEqual({
      channelId: 31,
      sessionScoped: true,
      concurrencyLimit: 1,
      activeLeaseCount: 1,
      waitingCount: 1,
      loadRatio: 2,
      saturated: true,
    });

    first.lease.release();
    await vi.advanceTimersByTimeAsync(0);

    const second = await secondPromise;
    expect(second.status).toBe('acquired');
    if (second.status === 'acquired') {
      second.lease.release();
    }
  });

  it('treats structured oauth providers as session-scoped in load snapshots', () => {
    expect(proxyChannelCoordinator.getChannelLoadSnapshot({
      channelId: 41,
      accountExtraConfig: JSON.stringify({ credentialMode: 'session' }),
      accountOauthProvider: 'codex',
    })).toEqual({
      channelId: 41,
      sessionScoped: true,
      concurrencyLimit: 1,
      activeLeaseCount: 0,
      waitingCount: 0,
      loadRatio: 0,
      saturated: false,
    });
  });

  it('increments sticky hit count across same-channel rebinds and resets on channel change', () => {
    const key = proxyChannelCoordinator.buildStickySessionKey({
      clientKind: 'codex',
      sessionId: 'hit-count-1',
      requestedModel: 'gpt-5.2',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 9,
    });

    expect(proxyChannelCoordinator.incrementStickyHitCount(key)).toBe(0);

    proxyChannelCoordinator.bindStickyChannel(key, 42, JSON.stringify({ credentialMode: 'session' }));
    expect(proxyChannelCoordinator.incrementStickyHitCount(key)).toBe(1);
    expect(proxyChannelCoordinator.incrementStickyHitCount(key)).toBe(2);
    expect(proxyChannelCoordinator.incrementStickyHitCount(key)).toBe(3);

    proxyChannelCoordinator.bindStickyChannel(key, 42, JSON.stringify({ credentialMode: 'session' }));
    expect(proxyChannelCoordinator.incrementStickyHitCount(key)).toBe(4);

    proxyChannelCoordinator.bindStickyChannel(key, 43, JSON.stringify({ credentialMode: 'session' }));
    expect(proxyChannelCoordinator.incrementStickyHitCount(key)).toBe(1);
  });

  it('increments last-success hit count across same-channel rebinds and resets on channel change', () => {
    const input = { requestedModel: 'grok-4.5', downstreamApiKeyId: 3 };
    proxyChannelCoordinator.rememberLastSuccessChannel({ ...input, channelId: 77 });

    expect(proxyChannelCoordinator.incrementLastSuccessHitCount(input)).toBe(1);
    expect(proxyChannelCoordinator.incrementLastSuccessHitCount(input)).toBe(2);

    proxyChannelCoordinator.rememberLastSuccessChannel({ ...input, channelId: 77 });
    expect(proxyChannelCoordinator.incrementLastSuccessHitCount(input)).toBe(3);

    proxyChannelCoordinator.rememberLastSuccessChannel({ ...input, channelId: 88 });
    expect(proxyChannelCoordinator.incrementLastSuccessHitCount(input)).toBe(1);
  });
});
