import { describe, expect, it, vi } from 'vitest';

const neverSettles = () => new Promise<never>(() => {});

vi.mock('./modelService.js', () => ({
  refreshModelsAndRebuildRoutes: vi.fn(async () => ({ refresh: [], rebuild: {} })),
  rebuildTokenRoutesFromAvailability: vi.fn(async () => ({})),
}));

import { refreshModelsAndRebuildRoutes } from './modelService.js';
import {
  computeSchedulerRefreshTimeoutMs,
  refreshModelsAndRebuildRoutesBounded,
  refreshModelsAndRebuildRoutesWithSchedulerBound,
} from './routeRefreshWorkflow.js';

describe('computeSchedulerRefreshTimeoutMs', () => {
  it('keeps the 120 s floor for small deployments', () => {
    expect(computeSchedulerRefreshTimeoutMs(0)).toBe(120_000);
    expect(computeSchedulerRefreshTimeoutMs(1)).toBe(120_000);
    expect(computeSchedulerRefreshTimeoutMs(10)).toBe(120_000);
  });

  it('scales the bound with account count', () => {
    expect(computeSchedulerRefreshTimeoutMs(100)).toBe(1_200_000);
    expect(computeSchedulerRefreshTimeoutMs(250)).toBe(3_000_000);
  });

  it('caps the bound at one hour', () => {
    expect(computeSchedulerRefreshTimeoutMs(400)).toBe(3_600_000);
    expect(computeSchedulerRefreshTimeoutMs(1_000)).toBe(3_600_000);
  });
});

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
