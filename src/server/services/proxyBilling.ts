import {
  buildProxyBillingDetails,
  estimateProxyCost,
  type ProxyBillingDetails,
  type ProxyBillingPricingOverride,
} from './modelPricingService.js';
import type { SelfLogBillingMeta } from './proxyUsageFallbackService.js';

interface ProxyBillingUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  promptTokensIncludeCache: boolean | null;
}

interface ResolvedProxyUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  recoveredFromSelfLog: boolean;
  estimatedCostFromQuota: number;
  selfLogBillingMeta: SelfLogBillingMeta | null;
}

interface ResolveProxyLogBillingInput {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
  modelName: string;
  parsedUsage: ProxyBillingUsageSummary;
  resolvedUsage: ResolvedProxyUsageSummary;
}

function toPricingOverride(meta: SelfLogBillingMeta | null): ProxyBillingPricingOverride | null {
  if (!meta) return null;
  return {
    modelRatio: meta.modelRatio,
    completionRatio: meta.completionRatio,
    cacheRatio: meta.cacheRatio,
    cacheCreationRatio: meta.cacheCreationRatio,
    groupRatio: meta.groupRatio,
  };
}

export async function resolveProxyLogBilling(
  input: ResolveProxyLogBillingInput,
): Promise<{ estimatedCost: number; billingDetails: ProxyBillingDetails | null }> {
  const selfLogMeta = input.resolvedUsage.selfLogBillingMeta;
  const billingPricingOverride = toPricingOverride(selfLogMeta);
  const cacheReadTokens = selfLogMeta?.cacheReadTokens ?? input.parsedUsage.cacheReadTokens;
  const cacheCreationTokens = selfLogMeta?.cacheCreationTokens ?? input.parsedUsage.cacheCreationTokens;
  const promptTokensIncludeCache = selfLogMeta?.promptTokensIncludeCache
    ?? input.parsedUsage.promptTokensIncludeCache;

  const billingInput = {
    site: input.site,
    account: input.account,
    modelName: input.modelName,
    promptTokens: input.resolvedUsage.promptTokens,
    completionTokens: input.resolvedUsage.completionTokens,
    totalTokens: input.resolvedUsage.totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    promptTokensIncludeCache,
    billingPricingOverride,
  };

  let estimatedCost = await estimateProxyCost(billingInput);
  const billingDetails = await buildProxyBillingDetails(billingInput);

  if (
    input.resolvedUsage.estimatedCostFromQuota > 0
    && (input.resolvedUsage.recoveredFromSelfLog || estimatedCost <= 0)
  ) {
    estimatedCost = input.resolvedUsage.estimatedCostFromQuota;
  }

  return {
    estimatedCost,
    billingDetails,
  };
}
