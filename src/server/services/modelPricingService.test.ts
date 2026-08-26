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

  it('uses the token-bound group over the model enableGroups order', () => {
    // glm goes to a user whose token is bound to "vercel glm" at 0.1×,
    // not the default group at 4×. The catalog's enableGroups order
    // would incorrectly pick default (4×) if we didn't know the binding.
    const model: PricingModel = {
      modelName: 'glm-5.2',
      quotaType: 0,
      modelRatio: 0.7,
      completionRatio: 3.142857,
      cacheRatio: 1,
      cacheCreationRatio: 1,
      modelPrice: null,
      enableGroups: ['default', 'vercel glm'],
    };
    const groupRatio = { default: 4, 'vercel glm': 0.1 };

    const withTokenGroup = calculateModelUsageCost(
      model,
      { promptTokens: 419, completionTokens: 262, totalTokens: 681 },
      groupRatio,
      'vercel glm',
    );
    const withoutTokenGroup = calculateModelUsageCost(
      model,
      { promptTokens: 419, completionTokens: 262, totalTokens: 681 },
      groupRatio,
    );

    // Without tokenGroup: default group (4×) → much higher cost.
    // (419 × 1.4 + 262 × 4.4) × 4 / 1e6 ≈ 0.006957
    expect(withoutTokenGroup).toBeCloseTo(0.006957, 4);
    // With tokenGroup: vercel glm (0.1×) → 40× cheaper, matches upstream.
    expect(withTokenGroup).toBeCloseTo(0.000174, 6);
    expect(withTokenGroup).toBeLessThan(withoutTokenGroup);
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

  describe('tiered_expr billing (NewAPI billing_mode=tiered_expr)', () => {
    // luna upstream bill: 77,995 prompt + 130 completion → $0.3151
    // expr: len <= 272000 ? tier("<=272K", p*1 + c*6 + cr*0.1) : tier(">272K", p*2 + c*9 + cr*0.2)
    const luna: PricingModel = {
      modelName: 'gpt-5.6-luna',
      quotaType: 0,
      modelRatio: 37.5,
      completionRatio: 6,
      cacheRatio: 0.1,
      cacheCreationRatio: 1.25,
      modelPrice: null,
      enableGroups: ['codex', 'default'],
      billingMode: 'tiered_expr',
      billingExpr:
        'len <= 272000 ? tier("<=272K", p * 1 + c * 6 + cr * 0.1) : tier(">272K", p * 2 + c * 9 + cr * 0.2)',
    };

    it('settles the upstream luna bill exactly (default group ratio 4)', () => {
      const cost = calculateModelUsageCost(
        luna,
        {
          promptTokens: 77995,
          completionTokens: 130,
          totalTokens: 78125,
        },
        { default: 4 },
      );
      // (77995*1 + 130*6) * 4 / 1e6 = 78775 * 4 / 1e6 = 0.3151
      expect(cost).toBeCloseTo(0.3151, 4);
    });

    it('handles the >272K tier (p*2 + c*9)', () => {
      const cost = calculateModelUsageCost(
        luna,
        {
          promptTokens: 300_000,
          completionTokens: 10_000,
          totalTokens: 310_000,
        },
        { default: 4 },
      );
      // (300000*2 + 10000*9) * 4 / 1e6 = 690000 * 4 / 1e6 = 2.76
      expect(cost).toBeCloseTo(2.76, 4);
    });

    it('exposes breakdown totalCost matching the settlement amount', () => {
      const details = calculateModelUsageBreakdown(
        luna,
        {
          promptTokens: 77995,
          completionTokens: 130,
          totalTokens: 78125,
        },
        { default: 4 },
      );
      expect(details).not.toBeNull();
      expect(details!.breakdown.totalCost).toBeCloseTo(0.3151, 4);
    });

    it('respects the group multiplier (default=1 vs default=4)', () => {
      const costOne = calculateModelUsageCost(
        luna,
        { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 },
        { default: 1 },
      );
      const costFour = calculateModelUsageCost(
        luna,
        { promptTokens: 1000, completionTokens: 0, totalTokens: 1000 },
        { default: 4 },
      );
      expect(costFour).toBeCloseTo(costOne * 4, 6);
    });

    it('supports caroline fixed-probe tier (200000 quota = $0.2/req)', () => {
      const probeModel: PricingModel = {
        modelName: 'gpt-5.6-sol',
        quotaType: 0,
        modelRatio: 0.75,
        completionRatio: 6,
        modelPrice: null,
        enableGroups: ['default'],
        billingMode: 'tiered_expr',
        billingExpr: 'len > 0 && len < 2500 ? tier("probe", 200000) : tier("normal", p * 1 + c * 6 + cr * 0.5)',
      };
      const cost = calculateModelUsageCost(
        probeModel,
        { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        { default: 1 },
      );
      // 200000 * 1 / 1e6 = 0.2
      expect(cost).toBeCloseTo(0.2, 4);
    });
  });
});
