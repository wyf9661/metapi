export interface DownstreamRoutingPolicy {
  supportedModels: string[];
  allowedRouteIds: number[];
  siteWeightMultipliers: Record<number, number>;
  denyAllWhenEmpty?: boolean;
}

export const EMPTY_DOWNSTREAM_ROUTING_POLICY: DownstreamRoutingPolicy = {
  supportedModels: [],
  allowedRouteIds: [],
  siteWeightMultipliers: {},
};
