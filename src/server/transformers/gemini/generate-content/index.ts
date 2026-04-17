import type { CanonicalRequestEnvelope } from '../../canonical/types.js';
import type { ProtocolBuildContext, ProtocolParseContext } from '../../contracts.js';
import {
  resolveGeminiGenerateContentUrl,
  resolveGeminiModelsUrl,
  resolveGeminiNativeBaseUrl,
} from './urlResolver.js';
export {
  resolveGeminiGenerateContentUrl,
  resolveGeminiModelsUrl,
  resolveGeminiNativeBaseUrl,
} from './urlResolver.js';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveGeminiProxyApiVersion(params: { geminiApiVersion?: unknown } | null | undefined): string {
  return (typeof params?.geminiApiVersion === 'string' ? params.geminiApiVersion.trim() : '') || 'v1beta';
}

export function parseGeminiProxyRequestPath(input: {
  rawUrl?: string | null;
  params?: { geminiApiVersion?: unknown } | null;
}): {
  apiVersion: string;
  modelActionPath: string;
  requestedModel: string;
  isStreamAction: boolean;
} {
  const apiVersion = resolveGeminiProxyApiVersion(input.params);
  const rawUrl = asTrimmedString(input.rawUrl);
  const withoutQuery = rawUrl.split('?')[0] || rawUrl;
  const normalizedVersion = apiVersion.replace(/^\/+/, '');
  const geminiPrefix = `/gemini/${normalizedVersion}/`;
  const aliasPrefix = `/${normalizedVersion}/`;

  let modelActionPath = withoutQuery.replace(/^\/+/, '');
  if (withoutQuery.startsWith(geminiPrefix)) {
    modelActionPath = withoutQuery.slice(geminiPrefix.length);
  } else if (withoutQuery.startsWith(aliasPrefix)) {
    modelActionPath = withoutQuery.slice(aliasPrefix.length);
  }

  const requestedModel = modelActionPath.replace(/^models\//, '').split(':')[0].trim();
  return {
    apiVersion,
    modelActionPath,
    requestedModel,
    isStreamAction: modelActionPath.endsWith(':streamGenerateContent'),
  };
}

import { geminiGenerateContentInbound } from './inbound.js';
import { geminiGenerateContentResponseBridge } from './responseBridge.js';
import { geminiGenerateContentStream } from './streamBridge.js';
import { createGeminiGenerateContentAggregateState, applyGeminiGenerateContentAggregate } from './aggregator.js';
import { geminiGenerateContentUsage } from './usage.js';
import { reasoningEffortToGeminiThinkingConfig, geminiThinkingConfigToReasoning } from './convert.js';
import { buildOpenAiBodyFromGeminiRequest, serializeNormalizedFinalToGemini } from './compatibility.js';
import {
  buildCanonicalRequestToGeminiGenerateContentBody,
  parseGeminiGenerateContentRequestToCanonical,
} from './requestBridge.js';

export const geminiGenerateContentTransformer = {
  protocol: 'gemini/generate-content' as const,
  inbound: geminiGenerateContentInbound,
  outbound: geminiGenerateContentResponseBridge,
  stream: geminiGenerateContentStream,
  aggregator: {
    createState: createGeminiGenerateContentAggregateState,
    apply: applyGeminiGenerateContentAggregate,
  },
  usage: geminiGenerateContentUsage,
  convert: {
    reasoningEffortToGeminiThinkingConfig,
    geminiThinkingConfigToReasoning,
  },
  compatibility: {
    buildOpenAiBodyFromGeminiRequest,
    serializeNormalizedFinalToGemini,
  },
  parseProxyRequestPath: parseGeminiProxyRequestPath,
  resolveProxyApiVersion: resolveGeminiProxyApiVersion,
  resolveBaseUrl: resolveGeminiNativeBaseUrl,
  resolveModelsUrl: resolveGeminiModelsUrl,
  resolveActionUrl: resolveGeminiGenerateContentUrl,
  parseRequest(
    body: unknown,
    ctx?: ProtocolParseContext,
  ): { value?: CanonicalRequestEnvelope; error?: { statusCode: number; payload: unknown } } {
    return parseGeminiGenerateContentRequestToCanonical(body, ctx);
  },
  buildProtocolRequest(
    request: CanonicalRequestEnvelope,
    _ctx?: ProtocolBuildContext,
  ): Record<string, unknown> {
    return buildCanonicalRequestToGeminiGenerateContentBody(request);
  },
};

export {
  geminiGenerateContentInbound,
  geminiGenerateContentResponseBridge as geminiGenerateContentOutbound,
  geminiGenerateContentStream,
  createGeminiGenerateContentAggregateState,
  applyGeminiGenerateContentAggregate,
  geminiGenerateContentUsage,
  reasoningEffortToGeminiThinkingConfig,
  geminiThinkingConfigToReasoning,
  buildOpenAiBodyFromGeminiRequest,
  serializeNormalizedFinalToGemini,
};
