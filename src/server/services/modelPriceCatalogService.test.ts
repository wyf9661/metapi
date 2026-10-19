import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  __setModelsDevPricesForTests,
  lookupModelsDevPrice,
  modelsDevCostToPricingModel,
  normalizeModelName,
  parseModelsDevPrices,
  syncModelsDevPrices,
  type ModelsDevCost,
} from './modelPriceCatalogService.js';

const insertValuesMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../db/index.js', () => {
  const insertChain = {
    run: () => ({}),
    values: (...args: unknown[]) => {
      insertValuesMock(...args);
      return insertChain;
    },
  };
  return {
    db: {
      insert: () => insertChain,
    },
    schema: {
      events: {},
    },
  };
});

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

// Real models.dev/api.json shape: { provider: { models: { id: { cost } } } }
const SAMPLE_PAYLOAD = JSON.stringify({
  openai: {
    id: 'openai',
    models: {
      'gpt-4o': { id: 'gpt-4o', cost: { input: 2.5, output: 10, cache_read: 1.25 } },
      'gpt-4o-mini': { id: 'gpt-4o-mini', cost: { input: 0.15, output: 0.6, cache_read: 0.075 } },
      'gpt-4o-2024-08-06': { id: 'gpt-4o-2024-08-06', cost: { input: 2.5, output: 10, cache_read: 1.25 } },
      'no-cost-model': { id: 'no-cost-model' },
    },
  },
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-3-7-sonnet': {
        id: 'claude-3-7-sonnet',
        cost: { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
      },
    },
  },
  deepseek: {
    id: 'deepseek',
    models: {
      // Dated snapshot listed with its own price: an exact lookup must hit
      // this entry, not the base model's.
      'deepseek-v4-flash-0731': { id: 'deepseek-v4-flash-0731', cost: { input: 0.55, output: 2.19 } },
    },
  },
  'thirdparty-reseller': {
    id: 'thirdparty-reseller',
    models: {
      // Same id as openai's — official price must win (keep-first).
      'gpt-4o': { id: 'gpt-4o', cost: { input: 20, output: 80 } },
      // Third-party-only models still enter the table.
      'unique-thirdparty-model': { id: 'unique-thirdparty-model', cost: { input: 1, output: 2 } },
      // Relay-style prefixed ids: the model name lives AFTER the slash, so
      // keying must keep the base name (old rule keyed these under junk
      // prefixes like `@cf` and lost the model entirely).
      '@cf/meta/llama-3.1-8b-instruct-fp8': { id: '@cf/meta/llama-3.1-8b-instruct-fp8', cost: { input: 0.05, output: 0.13 } },
      'stepfun/step-5-preview:free': { id: 'stepfun/step-5-preview:free', cost: { input: 0.1, output: 0.4 } },
      // Base model of the dated deepseek snapshot above.
      'deepseek-v4-flash': { id: 'deepseek-v4-flash', cost: { input: 0.2, output: 0.8 } },
    },
  },
});

describe('modelPriceCatalogService', () => {
  beforeEach(() => {
    __setModelsDevPricesForTests(new Map());
  });

  describe('parseModelsDevPrices', () => {
    it('parses official provider prices with cache fields', () => {
      const prices = parseModelsDevPrices(SAMPLE_PAYLOAD);
      expect(prices).not.toBeNull();
      expect(prices!.get('gpt-4o')).toEqual({ input: 2.5, output: 10, cacheRead: 1.25 });
      expect(prices!.get('claude-3-7-sonnet')).toEqual({
        input: 3,
        output: 15,
        cacheWrite: 3.75,
        cacheRead: 0.3,
      });
    });

    it('keeps official provider price over a third-party reseller for the same model id', () => {
      const prices = parseModelsDevPrices(SAMPLE_PAYLOAD)!;
      expect(prices.get('gpt-4o')).toEqual({ input: 2.5, output: 10, cacheRead: 1.25 });
    });

    it('still ingests third-party-only models', () => {
      const prices = parseModelsDevPrices(SAMPLE_PAYLOAD)!;
      expect(prices.get('unique-thirdparty-model')).toEqual({ input: 1, output: 2 });
    });

    it('skips models without a usable cost', () => {
      const prices = parseModelsDevPrices(SAMPLE_PAYLOAD)!;
      expect(prices.has('no-cost-model')).toBe(false);
    });

    it('returns null for invalid JSON or empty payloads', () => {
      expect(parseModelsDevPrices('not json')).toBeNull();
      expect(parseModelsDevPrices('{"openai": {}}')).not.toBeNull();
      expect(parseModelsDevPrices('[]')).toBeNull();
    });

    it('normalizes model ids to lowercase', () => {
      const payload = JSON.stringify({
        openai: { models: { 'GPT-4o': { cost: { input: 2.5, output: 10 } } } },
      });
      const prices = parseModelsDevPrices(payload)!;
      expect(prices.has('gpt-4o')).toBe(true);
    });

    it('keys relay-prefixed ids by the base model name, not the prefix', () => {
      const prices = parseModelsDevPrices(SAMPLE_PAYLOAD)!;
      // '@cf/meta/llama-3.1-8b-instruct-fp8' must be findable by its name
      // (the old rule cut at the first '/', keying it under junk '@cf').
      expect(prices.get('llama-3.1-8b-instruct-fp8')).toEqual({ input: 0.05, output: 0.13 });
      expect(prices.has('@cf')).toBe(false);
      // 'stepfun/step-5-preview:free' → base name after the slash, tag dropped.
      expect(prices.get('step-5-preview')).toEqual({ input: 0.1, output: 0.4 });
      expect(prices.has('stepfun')).toBe(false);
    });
  });

  describe('normalizeModelName', () => {
    it('takes the last slash segment and drops variant tags', () => {
      expect(normalizeModelName('cline-free/step-5-preview')).toBe('step-5-preview');
      expect(normalizeModelName('@cf/deepseek-ai/deepseek-v4-flash-0731')).toBe('deepseek-v4-flash-0731');
      expect(normalizeModelName('gpt-4o:free')).toBe('gpt-4o');
      expect(normalizeModelName('qwen3.5:2b')).toBe('qwen3.5');
      expect(normalizeModelName('NousResearch/hermes-4-405b:thinking')).toBe('hermes-4-405b');
      expect(normalizeModelName('DeepSeek-V4-Flash-0731')).toBe('deepseek-v4-flash-0731');
      expect(normalizeModelName('  ')).toBe('');
    });
  });

  describe('lookupModelsDevPrice', () => {
    beforeEach(() => {
      __setModelsDevPricesForTests(
        new Map<string, ModelsDevCost>([
          ['gpt-4o', { input: 2.5, output: 10, cacheRead: 1.25 }],
          ['claude-3-7-sonnet', { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }],
        ]),
      );
    });

    it('resolves an exact model name', () => {
      expect(lookupModelsDevPrice('gpt-4o')).toEqual({ input: 2.5, output: 10, cacheRead: 1.25 });
    });

    it('strips :free / :reasoning variant suffixes', () => {
      expect(lookupModelsDevPrice('gpt-4o:free')).toEqual({
        input: 2.5,
        output: 10,
        cacheRead: 1.25,
      });
      expect(lookupModelsDevPrice('gpt-4o:reasoning')).not.toBeNull();
    });

    it('strips vendor date suffixes before matching', () => {
      expect(lookupModelsDevPrice('gpt-4o-2025-01-01')).toEqual({
        input: 2.5,
        output: 10,
        cacheRead: 1.25,
      });
      expect(lookupModelsDevPrice('claude-3-7-sonnet-20250219')).toEqual({
        input: 3,
        output: 15,
        cacheWrite: 3.75,
        cacheRead: 0.3,
      });
      expect(lookupModelsDevPrice('gpt-4o-20250101')).not.toBeNull();
    });

    it('finds relay-prefixed and tagged requests by their base model name', () => {
      // Real 14-day flat-fallback population: `cline-free/step-5-preview`
      // was cut to the junk key `cline-free` and missed the table entirely.
      __setModelsDevPricesForTests(
        new Map<string, ModelsDevCost>([
          ['step-5-preview', { input: 1, output: 2.7 }],
          ['mimo-v2.6-flash', { input: 0.12, output: 0.25 }],
        ]),
      );
      expect(lookupModelsDevPrice('cline-free/step-5-preview')).toEqual({ input: 1, output: 2.7 });
      expect(lookupModelsDevPrice('cline-free/mimo-v2.6-flash')).toEqual({ input: 0.12, output: 0.25 });
      expect(lookupModelsDevPrice('stepfun/step-5-preview:free')).toEqual({ input: 1, output: 2.7 });
    });

    it('prefers an exact dated table entry, else falls back to the base snapshot price', () => {
      __setModelsDevPricesForTests(
        new Map<string, ModelsDevCost>([
          ['deepseek-v4-flash', { input: 0.2, output: 0.8 }],
          ['deepseek-v4-flash-0731', { input: 0.55, output: 2.19 }],
        ]),
      );
      // The table lists the snapshot with its own price: exact must win.
      expect(lookupModelsDevPrice('deepseek-v4-flash-0731')).toEqual({ input: 0.55, output: 2.19 });
      // MMDD/YYMMDD snapshots with no exact entry fall back to the base price
      // (the old stripDateSuffix missed MMDD and billed these flat fallback).
      expect(lookupModelsDevPrice('deepseek-ai/deepseek-v4-flash-0731')).toEqual({ input: 0.55, output: 2.19 });
      __setModelsDevPricesForTests(
        new Map<string, ModelsDevCost>([['deepseek-v4-flash', { input: 0.2, output: 0.8 }]]),
      );
      expect(lookupModelsDevPrice('DeepSeek-V4-Flash-0731')).toEqual({ input: 0.2, output: 0.8 });
      expect(lookupModelsDevPrice('deepseek-v4-flash-260731')).toEqual({ input: 0.2, output: 0.8 });
    });

    it('returns null for unknown models', () => {
      expect(lookupModelsDevPrice('definitely-not-a-real-model')).toBeNull();
      expect(lookupModelsDevPrice('')).toBeNull();
    });
  });

  describe('modelsDevCostToPricingModel', () => {
    it('converts USD/M into quota-aligned ratios (1 unit = $1)', () => {
      const model = modelsDevCostToPricingModel('gpt-4o', {
        input: 2.5,
        output: 10,
        cacheRead: 1.25,
      });
      expect(model.quotaType).toBe(0);
      expect(model.modelRatio).toBe(1.25);
      expect(model.completionRatio).toBe(4);
      expect(model.cacheRatio).toBe(0.5);
      expect(model.cacheCreationRatio).toBe(1);
      expect(model.enableGroups).toEqual(['default']);
    });

    it('maps cache write price to cache creation ratio', () => {
      const model = modelsDevCostToPricingModel('claude-3-7-sonnet', {
        input: 3,
        output: 15,
        cacheWrite: 3.75,
        cacheRead: 0.3,
      });
      expect(model.cacheCreationRatio).toBe(1.25);
      expect(model.cacheRatio).toBeCloseTo(0.1, 10);
    });
  });

  describe('syncModelsDevPrices failure handling', () => {
    beforeEach(() => {
      fetchMock.mockReset();
      insertValuesMock.mockReset();
    });

    it('records a status event and returns false when the fetch fails', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      const ok = await syncModelsDevPrices();
      expect(ok).toBe(false);
      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status',
          title: '模型价格同步失败',
          level: 'warning',
        }),
      );
    });

    it('records an event on HTTP error responses', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => '' });
      const ok = await syncModelsDevPrices();
      expect(ok).toBe(false);
      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('HTTP 503') }),
      );
    });

    it('does not write an event on a successful sync', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => SAMPLE_PAYLOAD });
      const ok = await syncModelsDevPrices();
      expect(ok).toBe(true);
      expect(insertValuesMock).not.toHaveBeenCalled();
    });

    it('keeps returning false when event persistence itself fails', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      insertValuesMock.mockImplementationOnce(() => {
        throw new Error('db down');
      });
      const ok = await syncModelsDevPrices();
      expect(ok).toBe(false);
    });
  });
});
