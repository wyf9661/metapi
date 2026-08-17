export type DownstreamAccountTokenCredentialRef = {
  kind: 'account_token';
  siteId: number;
  accountId: number;
  tokenId: number;
};

export type DownstreamDefaultApiKeyCredentialRef = {
  kind: 'default_api_key';
  siteId: number;
  accountId: number;
};

export type DownstreamExcludedCredentialRef =
  | DownstreamAccountTokenCredentialRef
  | DownstreamDefaultApiKeyCredentialRef;

export type DownstreamModelMapping = {
  from: string;
  to: string;
};

export type DownstreamRoutingPolicy = {
  supportedModels: string[];
  modelMappings?: DownstreamModelMapping[];
  allowedRouteIds: number[];
  siteWeightMultipliers: Record<number, number>;
  excludedSiteIds: number[];
  excludedCredentialRefs: DownstreamExcludedCredentialRef[];
  denyAllWhenEmpty?: boolean;
};

export function resolveDownstreamPolicyModel(
  requestedModel: string,
  policy: DownstreamRoutingPolicy,
): string {
  const model = requestedModel.trim();
  if (!model) return model;
  for (const mapping of policy.modelMappings ?? []) {
    const from = mapping.from.trim();
    const to = mapping.to.trim();
    if (!from || !to) continue;
    if (from === model) return to;
    if (from.toLowerCase().startsWith('re:')) {
      try {
        if (new RegExp(from.slice(3).trim()).test(model)) return to;
      } catch {
        continue;
      }
    }
    if (from.includes('*')) {
      const escaped = from.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (new RegExp(`^${escaped}$`).test(model)) return to;
    }
  }
  return model;
}

export const EMPTY_DOWNSTREAM_ROUTING_POLICY: DownstreamRoutingPolicy = {
  supportedModels: [],
  modelMappings: [],
  allowedRouteIds: [],
  siteWeightMultipliers: {},
  excludedSiteIds: [],
  excludedCredentialRefs: [],
};
