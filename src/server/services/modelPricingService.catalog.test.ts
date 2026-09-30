import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: (...args: unknown[]) => fetchMock(...args) };
});

vi.mock('./siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: unknown, init: unknown) => init,
}));

vi.mock('./platforms/newApiShield.js', () => ({
  buildNewApiCookieCandidates: () => [],
  fetchJsonWithShieldCookieRetry: async () => ({ data: null }),
  isShieldCooldownActive: () => false,
}));

import { fetchModelPricingCatalog } from './modelPricingService.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('modelPricingService marketplace catalog', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks tiered expression prices as reference-only instead of using placeholder ratios', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      data: [{
        model_name: 'deepseek-v4.1-flash',
        quota_type: 0,
        model_ratio: 37.5,
        completion_ratio: 1,
        cache_ratio: 0.1,
        enable_groups: ['default', 'advanced'],
        billing_mode: 'tiered_expr',
        billing_expr: 'tier("base", p * 0.3 + c * 1.2 + cr * 0.006)',
      }],
      group_ratio: { default: 1 },
    }));

    const catalog = await fetchModelPricingCatalog({
      site: { id: 1001, url: 'https://pricing.example.test', platform: 'new-api' },
      account: { id: 1001, apiToken: 'sk-test' },
      modelName: '__metadata__',
    });

    const entry = catalog?.models.find((model) => model.modelName === 'deepseek-v4.1-flash');
    expect(entry).toBeDefined();
    expect(entry!.groupPricing.default).toMatchObject({
      quotaType: 0,
      billingMode: 'tiered_expr',
      referenceOnly: true,
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
    });
    expect(entry!.groupPricing.default.inputPerMillion).not.toBe(75);
  });

  it('does not invent group prices for groups absent from group_ratio', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      data: [{
        model_name: 'gpt-6-astra',
        quota_type: 0,
        model_ratio: 10,
        completion_ratio: 5,
        enable_groups: ['admin', 'default', 'svip', 'vip'],
      }],
      group_ratio: { default: 1, '【GPT】降智号池': 0.05 },
    }));

    const catalog = await fetchModelPricingCatalog({
      site: { id: 1002, url: 'https://pricing.example.test', platform: 'new-api' },
      account: { id: 1002, apiToken: 'sk-test' },
      modelName: '__metadata__',
    });

    const entry = catalog?.models.find((model) => model.modelName === 'gpt-6-astra');
    expect(entry).toBeDefined();
    expect(Object.keys(entry!.groupPricing)).toEqual(['default']);
    expect(entry!.groupPricing.default).toMatchObject({
      inputPerMillion: 20,
      outputPerMillion: 100,
    });
  });
});
