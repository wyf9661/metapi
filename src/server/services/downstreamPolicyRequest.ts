import type { FastifyReply, FastifyRequest } from 'fastify';
import { getProxyAuthContext } from '../middleware/auth.js';
import {
  isModelAllowedByPolicyOrAllowedRoutes,
  recordManagedKeyCostUsage,
} from './downstreamApiKeyService.js';
import {
  EMPTY_DOWNSTREAM_ROUTING_POLICY,
  resolveDownstreamPolicyModel,
  type DownstreamRoutingPolicy,
} from './downstreamPolicyTypes.js';

export function getDownstreamRoutingPolicy(request: FastifyRequest): DownstreamRoutingPolicy {
  const authContext = getProxyAuthContext(request);
  if (!authContext) return EMPTY_DOWNSTREAM_ROUTING_POLICY;
  return authContext.policy;
}

export function resolveModelForDownstreamKey(
  request: FastifyRequest,
  requestedModel: string,
): { requestedModel: string; effectiveModel: string; mapped: boolean } {
  const normalizedRequestedModel = requestedModel.trim();
  const authContext = getProxyAuthContext(request);
  const effectiveModel = resolveDownstreamPolicyModel(normalizedRequestedModel, authContext?.policy ?? EMPTY_DOWNSTREAM_ROUTING_POLICY);
  return {
    requestedModel: normalizedRequestedModel,
    effectiveModel,
    mapped: effectiveModel !== normalizedRequestedModel,
  };
}

export async function ensureModelAllowedForDownstreamKey(
  request: FastifyRequest,
  reply: FastifyReply,
  requestedModel: string,
): Promise<boolean> {
  const authContext = getProxyAuthContext(request);
  if (!authContext) return true;

  const effectiveModel = resolveDownstreamPolicyModel(requestedModel, authContext.policy);
  if (await isModelAllowedByPolicyOrAllowedRoutes(effectiveModel, authContext.policy)) {
    return true;
  }

  reply.code(403).send({
    error: {
      message: `Model not allowed for this API key: ${requestedModel}`,
      type: 'permission_error',
    },
  });
  return false;
}

export function recordDownstreamCostUsage(request: FastifyRequest, estimatedCost: number): void {
  const authContext = getProxyAuthContext(request);
  if (!authContext || authContext.keyId === null) return;
  void recordManagedKeyCostUsage(authContext.keyId, estimatedCost);
}
