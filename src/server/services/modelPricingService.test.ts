import { describe, expect, it, beforeEach } from 'vitest';
import {
  calculateModelUsageBreakdown,
  calculateModelUsageCost,
  estimateWithModelsDevOrFallback,
  fallbackTokenCost,
  type PricingModel,
} from './modelPricingService.js';
import { __setModelsDevPricesForTests } from './modelPriceCatalogService.js';
import type { EstimateProxyCostInput } from './modelPricingService.js';

describe('modelPricingService', () => {
  it('calculates token-based cost from model ratio and completion ratio', () => {
    const model: PricingModel = {
      modelName: 'gpt-4o',
      quotaType: 0,
      modelRatio: 2,
      completionRatio: 1.5,
      modelPrice: null,
      enableGroups: ['vip'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      },
      { default: 1, vip: 2 },
    );

    expect(cost).toBe(0.014);
  });

  it('falls back to total tokens when split token usage is missing', () => {
    const model: PricingModel = {
      modelName: 'claude-sonnet',
      quotaType: 0,
      modelRatio: 1,
      completionRatio: 2,
      modelPrice: null,
      enableGroups: ['default'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 2000,
      },
      { default: 1 },
    );

    expect(cost).toBe(0.004);
  });

  it('calculates per-call cost when quota type is call-based', () => {
    const model: PricingModel = {
      modelName: 'gpt-image-1',
      quotaType: 1,
      modelRatio: 1,
      completionRatio: 1,
      modelPrice: 0.3,
      enableGroups: ['vip'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      { default: 1, vip: 1.5 },
    );

    expect(cost).toBe(0.45);
  });

  it('calculates times-based per-call cost from input ratio only', () => {
    const model: PricingModel = {
      modelName: 'flux-kontext-pro',
      quotaType: 1,
      modelRatio: 1,
      completionRatio: 1,
      modelPrice: { input: 1, output: 3 },
      enableGroups: ['vip'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      { default: 1, vip: 2 },
    );

    expect(cost).toBe(0.004);
  });

  it('splits cache read and cache creation costs from prompt cost', () => {
    const model: PricingModel = {
      modelName: 'gpt-4o',
      quotaType: 0,
      modelRatio: 2.5,
      completionRatio: 5,
      cacheRatio: 0.1,
      cacheCreationRatio: 1.25,
      modelPrice: null,
      enableGroups: ['default'],
    };

    const detail = calculateModelUsageBreakdown(
      model,
      {
        promptTokens: 146638,
        completionTokens: 172,
        totalTokens: 146810,
        cacheReadTokens: 145692,
        cacheCreationTokens: 945,
        promptTokensIncludeCache: true,
      },
      { default: 1 },
    );

    expect(detail).toMatchObject({
      usage: {
        billablePromptTokens: 1,
        cacheReadTokens: 145692,
        cacheCreationTokens: 945,
      },
      pricing: {
        modelRatio: 2.5,
        completionRatio: 5,
        cacheRatio: 0.1,
        cacheCreationRatio: 1.25,
        groupRatio: 1,
      },
      breakdown: {
        inputPerMillion: 5,
        outputPerMillion: 25,
        cacheReadPerMillion: 0.5,
        cacheCreationPerMillion: 6.25,
        inputCost: 0.000005,
        outputCost: 0.0043,
        cacheReadCost: 0.072846,
        cacheCreationCost: 0.005906,
        totalCost: 0.083057,
      },
    });
  });

  it('keeps prompt tokens intact when upstream reports cache tokens separately', () => {
    const model: PricingModel = {
      modelName: 'claude-sonnet',
      quotaType: 0,
      modelRatio: 3,
      completionRatio: 5,
      cacheRatio: 0.3,
      cacheCreationRatio: 1.25,
      modelPrice: null,
      enableGroups: ['default'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        cacheReadTokens: 1000,
        cacheCreationTokens: 40,
        promptTokensIncludeCache: false,
      },
      { default: 1 },
    );

    expect(cost).toBe(0.00372);
  });

  it('uses platform-specific fallback token divisor', () => {
    expect(fallbackTokenCost(1500, 'new-api')).toBe(0.003);
    expect(fallbackTokenCost(1500, 'new-api')).toBe(0.003);
  });

  describe('estimateWithModelsDevOrFallback (models.dev middle tier)', () => {
    const baseInput: EstimateProxyCostInput = {
      site: { id: 1, url: 'https://api.example.com', platform: 'openai' },
      account: { id: 1 },
      modelName: 'gpt-4o',
    };

    beforeEach(() => {
      __setModelsDevPricesForTests(
        new Map([['gpt-4o', { input: 2.5, output: 10, cacheRead: 1.25 }]]),
      );
    });

    it('bills by official models.dev price when upstream pricing is absent (1M+1M = $12.5)', () => {
      const cost = estimateWithModelsDevOrFallback(
        baseInput,
        { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
        2_000_000,
      );
      expect(cost).toBe(12.5);
    });

    it('deducts cache-read tokens from billable prompt tokens', () => {
      const cost = estimateWithModelsDevOrFallback(
        baseInput,
        {
          promptTokens: 1_000_000,
          completionTokens: 1_000_000,
          totalTokens: 2_000_000,
          cacheReadTokens: 500_000,
          promptTokensIncludeCache: true,
        },
        2_000_000,
      );
      // input: 0.5M billable × 2.5 = 1.25; cache read: 0.5M × 1.25 = 0.625; output: 1M × 10 = 10
      expect(cost).toBe(11.875);
    });

    it('falls back to the flat token divisor when the model is not in the catalog', () => {
      const input = { ...baseInput, modelName: 'unknown-model' };
      const cost = estimateWithModelsDevOrFallback(
        input,
        { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
        2_000_000,
      );
      expect(cost).toBe(fallbackTokenCost(2_000_000, 'openai'));
    });
  });
});
