import { describe, expect, it, vi } from 'vitest';

const estimateProxyCostMock = vi.fn();
const buildProxyBillingDetailsMock = vi.fn();

vi.mock('./modelPricingService.js', () => ({
  estimateProxyCost: (...args: unknown[]) => estimateProxyCostMock(...args),
  buildProxyBillingDetails: (...args: unknown[]) => buildProxyBillingDetailsMock(...args),
}));

import { resolveProxyLogBilling } from './proxyBilling.js';

describe('resolveProxyLogBilling', () => {
  it('uses billing breakdown total when the standalone estimate is zero', async () => {
    estimateProxyCostMock.mockResolvedValue(0);
    buildProxyBillingDetailsMock.mockResolvedValue({
      usage: {
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        billablePromptTokens: 55_347,
      },
      pricing: {
        modelRatio: 0.1,
        completionRatio: 2,
        cacheRatio: 0.2,
        cacheCreationRatio: 1,
        groupRatio: 1,
      },
      breakdown: {
        inputPerMillion: 0.2,
        outputPerMillion: 0.4,
        cacheReadPerMillion: 0.04,
        cacheCreationPerMillion: 0.2,
        totalCost: 0.011132,
      },
    });

    const result = await resolveProxyLogBilling({
      site: {
        id: 138,
        url: 'https://aitoken.forum',
        platform: 'new-api',
      },
      account: { id: 1 },
      modelName: 'DeepSeek-V4-Flash-0731',
      parsedUsage: {
        promptTokens: 55_347,
        completionTokens: 158,
        totalTokens: 55_505,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: true,
      },
      resolvedUsage: {
        promptTokens: 55_347,
        completionTokens: 158,
        totalTokens: 55_505,
        recoveredFromSelfLog: false,
        estimatedCostFromQuota: 0,
        selfLogBillingMeta: null,
      },
    });

    expect(result.estimatedCost).toBe(0.011132);
    expect(result.billingDetails?.breakdown.totalCost).toBe(0.011132);
  });

  it('uses self-log billing metadata for detail breakdown while preserving quota-derived total cost', async () => {
    estimateProxyCostMock.mockResolvedValue(0.010001);
    buildProxyBillingDetailsMock.mockResolvedValue({
      usage: {
        cacheReadTokens: 145692,
        cacheCreationTokens: 945,
        billablePromptTokens: 1,
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
        totalCost: 0.083057,
      },
    });

    const result = await resolveProxyLogBilling({
      site: {
        id: 1,
        url: 'https://new-api.example.com',
        platform: 'new-api',
      },
      account: {
        id: 2,
      },
      modelName: 'claude-haiku-4-5-20251001',
      parsedUsage: {
        promptTokens: 146638,
        completionTokens: 172,
        totalTokens: 146810,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: null,
      },
      resolvedUsage: {
        promptTokens: 146638,
        completionTokens: 172,
        totalTokens: 146810,
        recoveredFromSelfLog: true,
        estimatedCostFromQuota: 0.083056,
        selfLogBillingMeta: {
          modelRatio: 2.5,
          completionRatio: 5,
          cacheRatio: 0.1,
          cacheCreationRatio: 1.25,
          groupRatio: 1,
          cacheReadTokens: 145692,
          cacheCreationTokens: 945,
          promptTokensIncludeCache: true,
        },
      },
    });

    expect(estimateProxyCostMock).toHaveBeenCalledWith(expect.objectContaining({
      cacheReadTokens: 145692,
      cacheCreationTokens: 945,
      promptTokensIncludeCache: true,
      billingPricingOverride: {
        modelRatio: 2.5,
        completionRatio: 5,
        cacheRatio: 0.1,
        cacheCreationRatio: 1.25,
        groupRatio: 1,
      },
    }));
    expect(result.estimatedCost).toBe(0.083056);
    expect(result.billingDetails).toMatchObject({
      usage: {
        cacheReadTokens: 145692,
        cacheCreationTokens: 945,
        billablePromptTokens: 1,
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
        totalCost: 0.083057,
      },
    });
  });
});
