import { describe, expect, it, vi } from 'vitest';

const neverSettles = () => new Promise<never>(() => {});

vi.mock('./modelService.js', () => ({
  refreshModelsAndRebuildRoutes: vi.fn(async () => ({ refresh: [], rebuild: {} })),
  rebuildTokenRoutesFromAvailability: vi.fn(async () => ({})),
}));

import { refreshModelsAndRebuildRoutes } from './modelService.js';
import {
  refreshModelsAndRebuildRoutesBounded,
  refreshModelsAndRebuildRoutesWithSchedulerBound,
} from './routeRefreshWorkflow.js';

describe('scheduler-bound route refresh', () => {
  it('reports completion together with the underlying result', async () => {
    const outcome = await refreshModelsAndRebuildRoutesWithSchedulerBound(1_000);
    expect(outcome.completed).toBe(true);
    expect(outcome.result?.refresh).toEqual([]);
  });

  it('lands within its bound when the pass never settles', async () => {
    (refreshModelsAndRebuildRoutes as any).mockImplementationOnce(neverSettles);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const startedAt = Date.now();
    const outcome = await refreshModelsAndRebuildRoutesWithSchedulerBound(50);
    expect(outcome.completed).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('scheduled refresh did not complete');
    vi.restoreAllMocks();
  });

  it('keeps the request-path bound returning false when the pass never settles', async () => {
    (refreshModelsAndRebuildRoutes as any).mockImplementationOnce(neverSettles);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(refreshModelsAndRebuildRoutesBounded(50)).resolves.toBe(false);
    vi.restoreAllMocks();
  });
});
