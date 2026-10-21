import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateModelsSurfaceCache } from '../../services/modelsSurfaceCache.js';
import { listModelsSurface } from './modelsSurface.js';

describe('listModelsSurface', () => {
  beforeEach(() => {
    invalidateModelsSurfaceCache();
  });

  it('returns OpenAI list shape and hides models without a resolvable channel', async () => {
    const result = await listModelsSurface({
      downstreamPolicy: { type: 'all' },
      responseFormat: 'openai',
      tokenRouter: {
        getAvailableModels: vi.fn().mockResolvedValue(['routable-model', 'orphan-model']),
        explainSelection: vi.fn()
          .mockResolvedValueOnce({ selectedChannelId: null })
          .mockResolvedValueOnce({ selectedChannelId: 11 }),
      },
      refreshModelsAndRebuildRoutes: vi.fn(),
      isModelAllowed: vi.fn().mockResolvedValue(true),
      now: () => new Date('2026-03-19T00:00:00.000Z'),
    });

    expect(result).toEqual({
      object: 'list',
      data: [
        {
          id: 'routable-model',
          object: 'model',
          created: 1773878400,
          owned_by: 'metapi',
        },
      ],
    });
  });

  it('returns Claude list shape when requested', async () => {
    const result = await listModelsSurface({
      downstreamPolicy: { type: 'all' },
      responseFormat: 'claude',
      tokenRouter: {
        getAvailableModels: vi.fn().mockResolvedValue(['claude-opus-4-6']),
        explainSelection: vi.fn().mockResolvedValue({ selectedChannelId: 22 }),
      },
      refreshModelsAndRebuildRoutes: vi.fn(),
      isModelAllowed: vi.fn().mockResolvedValue(true),
      now: () => new Date('2026-03-19T00:00:00.000Z'),
    });

    expect(result).toEqual({
      data: [
        {
          id: 'claude-opus-4-6',
          type: 'model',
          display_name: 'claude-opus-4-6',
          created_at: '2026-03-19T00:00:00.000Z',
        },
      ],
      first_id: 'claude-opus-4-6',
      last_id: 'claude-opus-4-6',
      has_more: false,
    });
  });

  it('applies downstream policy filtering before selection checks and refreshes once when the first read is empty', async () => {
    const getAvailableModels = vi.fn()
      .mockResolvedValueOnce(['blocked-model'])
      .mockResolvedValueOnce(['allowed-model']);
    const refreshModelsAndRebuildRoutes = vi.fn().mockResolvedValue(undefined);
    const isModelAllowed = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const explainSelection = vi.fn().mockResolvedValue({ selectedChannelId: 33 });

    const result = await listModelsSurface({
      downstreamPolicy: { type: 'whitelist' },
      responseFormat: 'openai',
      tokenRouter: {
        getAvailableModels,
        explainSelection,
      },
      refreshModelsAndRebuildRoutes,
      isModelAllowed,
      now: () => new Date('2026-03-19T00:00:00.000Z'),
    });

    expect(refreshModelsAndRebuildRoutes).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      object: 'list',
      data: [
        {
          id: 'allowed-model',
          object: 'model',
          created: 1773878400,
          owned_by: 'metapi',
        },
      ],
    });
  });

  describe('response cache', () => {
    function makeInput(policy: unknown = { type: 'all' }) {
      const tokenRouter = {
        getAvailableModels: vi.fn().mockResolvedValue(['m1', 'm2']),
        explainSelection: vi.fn().mockResolvedValue({ selectedChannelId: 7 }),
      };
      return {
        downstreamPolicy: policy,
        responseFormat: 'openai' as const,
        tokenRouter,
        refreshModelsAndRebuildRoutes: vi.fn().mockResolvedValue(undefined),
        isModelAllowed: vi.fn().mockResolvedValue(true),
        now: () => new Date('2026-03-19T00:00:00.000Z'),
      };
    }

    it('serves a second identical request from cache while still rendering fresh timestamps', async () => {
      const first = makeInput();
      const r1 = await listModelsSurface(first);
      expect(first.tokenRouter.getAvailableModels).toHaveBeenCalledTimes(1);

      const second = { ...first, now: () => new Date('2026-03-20T00:00:00.000Z') };
      const r2 = await listModelsSurface(second);

      expect(first.tokenRouter.getAvailableModels).toHaveBeenCalledTimes(1);
      expect(first.tokenRouter.explainSelection).toHaveBeenCalledTimes(2);
      expect((r2 as { data: Array<{ id: string; created: number }> }).data.map((item) => item.id))
        .toEqual(['m1', 'm2']);
      const created1 = (r1 as { data: Array<{ created: number }> }).data[0].created;
      const created2 = (r2 as { data: Array<{ created: number }> }).data[0].created;
      expect(created2).toBe(created1 + 86400);
    });

    it('isolates cache entries by downstream policy', async () => {
      const policyA = makeInput({ supportedModels: ['a'] });
      const policyB = makeInput({ supportedModels: ['b'] });
      await listModelsSurface(policyA);
      await listModelsSurface(policyB);
      expect(policyA.tokenRouter.getAvailableModels).toHaveBeenCalledTimes(1);
      expect(policyB.tokenRouter.getAvailableModels).toHaveBeenCalledTimes(1);
    });

    it('isolates cache entries by response format', async () => {
      const openai = makeInput();
      await listModelsSurface(openai);
      const claude = {
        ...openai,
        responseFormat: 'claude' as const,
        now: () => new Date('2026-03-19T00:00:00.000Z'),
      };
      await listModelsSurface(claude);
      expect(openai.tokenRouter.getAvailableModels).toHaveBeenCalledTimes(2);
    });

    it('does not cache empty listings and keeps the refresh-and-reread path live', async () => {
      const input = {
        downstreamPolicy: { type: 'all' },
        responseFormat: 'openai' as const,
        tokenRouter: {
          getAvailableModels: vi.fn().mockResolvedValue([]),
          explainSelection: vi.fn(),
        },
        refreshModelsAndRebuildRoutes: vi.fn().mockResolvedValue(undefined),
        isModelAllowed: vi.fn().mockResolvedValue(true),
        now: () => new Date('2026-03-19T00:00:00.000Z'),
      };
      await listModelsSurface(input);
      await listModelsSurface(input);
      expect(input.refreshModelsAndRebuildRoutes).toHaveBeenCalledTimes(2);
      expect(input.tokenRouter.getAvailableModels).toHaveBeenCalledTimes(4);
    });
  });
});
