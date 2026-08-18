import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ get: () => undefined }),
      }),
    }),
  },
  schema: { settings: { key: 'key', value: 'value' } },
}));

vi.mock('../db/upsertSetting.js', () => ({
  upsertSetting: vi.fn().mockResolvedValue(undefined),
}));

describe('tokenRouterRuntimeHealthStore bounds', () => {
  beforeEach(async () => {
    const store = await import('./tokenRouterRuntimeHealthStore.js');
    store.resetSiteRuntimeHealthState();
  });

  it('bounds per-site model health and global site/sliding-window state', async () => {
    const store = await import('./tokenRouterRuntimeHealthStore.js');
    for (let index = 0; index <= store.tokenRouterRuntimeHealthLimits.maxModelsPerSite; index += 1) {
      store.recordSiteRuntimeSuccess(1, 100, `model-${index}`, index + 1);
    }
    const modelStats = store.__getTokenRouterRuntimeHealthStatsForTests();
    expect(modelStats.modelStatesBySite.get(1)).toBeLessThanOrEqual(
      store.tokenRouterRuntimeHealthLimits.maxModelsPerSite,
    );

    for (let siteId = 2; siteId <= store.tokenRouterRuntimeHealthLimits.maxSites + 2; siteId += 1) {
      store.recordSiteRuntimeSuccess(siteId, 100, 'shared-model', 10_000 + siteId);
    }

    const stats = store.__getTokenRouterRuntimeHealthStatsForTests();
    expect(stats.siteStates).toBeLessThanOrEqual(store.tokenRouterRuntimeHealthLimits.maxSites);
    expect(stats.slidingWindows).toBeLessThanOrEqual(store.tokenRouterRuntimeHealthLimits.maxSites);
  });
});
