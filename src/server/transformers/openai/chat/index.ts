import type { CanonicalRequestEnvelope } from '../../canonical/types.js';
import type { ProtocolBuildContext, ProtocolParseContext } from '../../contracts.js';
import { type NormalizedFinalResponse, type NormalizedStreamEvent, type StreamTransformContext } from '../../shared/normalized.js';
import { createChatEndpointStrategy } from '../../shared/chatEndpointStrategy.js';
import { openAiChatInbound } from './inbound.js';
import { createChatProxyStreamSession } from './proxyStream.js';
import {
  buildCanonicalRequestToOpenAiChatBody,
  parseOpenAiChatRequestToCanonical,
} from './requestBridge.js';
import {
  openAiChatResponseBridge,
  buildNormalizedFinalToOpenAiChatChunks,
  buildNormalizedFinalToOpenAiChatPayload,
  normalizeOpenAiChatFinalToNormalized,
} from './responseBridge.js';
import { openAiChatStream } from './streamBridge.js';
import { openAiChatUsage } from './usage.js';
import { createOpenAiChatAggregateState, applyOpenAiChatStreamEvent, finalizeOpenAiChatAggregate } from './aggregator.js';
import type {
  OpenAiChatParsedRequest as OpenAiChatParsedRequestModel,
  OpenAiChatRequestEnvelope as OpenAiChatRequestEnvelopeModel,
} from './model.js';

export const openAiChatTransformer = {
  protocol: 'openai/chat' as const,
  inbound: openAiChatInbound,
  outbound: openAiChatResponseBridge,
  stream: openAiChatStream,
  usage: openAiChatUsage,
  compatibility: {
    createEndpointStrategy: createChatEndpointStrategy,
  },
  aggregator: {
    createState: createOpenAiChatAggregateState,
    applyEvent: applyOpenAiChatStreamEvent,
    finalize: finalizeOpenAiChatAggregate,
  },
  proxyStream: {
    createSession: createChatProxyStreamSession,
  },
  parseRequest(
    body: unknown,
    ctx?: ProtocolParseContext,
  ): { value?: CanonicalRequestEnvelope; error?: { statusCode: number; payload: unknown } } {
    return parseOpenAiChatRequestToCanonical(body, ctx);
  },
  buildProtocolRequest(
    request: CanonicalRequestEnvelope,
    _ctx?: ProtocolBuildContext,
  ): Record<string, unknown> {
    return buildCanonicalRequestToOpenAiChatBody(request);
  },
  transformRequest(body: unknown): ReturnType<typeof openAiChatInbound.parse> {
    return openAiChatInbound.parse(body);
  },
  createStreamContext(modelName: string): StreamTransformContext {
    return openAiChatStream.createContext(modelName);
  },
  transformFinalResponse(payload: unknown, modelName: string, fallbackText = ''): NormalizedFinalResponse {
    return normalizeOpenAiChatFinalToNormalized(payload, modelName, fallbackText);
  },
  transformStreamEvent(payload: unknown, context: StreamTransformContext, modelName: string): NormalizedStreamEvent {
    return openAiChatStream.normalizeEvent(payload, context, modelName);
  },
  serializeStreamEvent(
    event: NormalizedStreamEvent,
    context: StreamTransformContext,
    claudeContext: Parameters<typeof openAiChatStream.serializeEvent>[2],
  ): string[] {
    return openAiChatStream.serializeEvent(event, context, claudeContext);
  },
  serializeDone(
    context: StreamTransformContext,
    claudeContext: Parameters<typeof openAiChatStream.serializeDone>[1],
  ): string[] {
    return openAiChatStream.serializeDone(context, claudeContext);
  },
  serializeFinalResponse(
    normalized: NormalizedFinalResponse,
    usage: Parameters<typeof buildNormalizedFinalToOpenAiChatPayload>[1],
  ) {
    return buildNormalizedFinalToOpenAiChatPayload(normalized, usage);
  },
  serializeUpstreamFinalAsStream(
    payload: unknown,
    modelName: string,
    fallbackText: string,
    streamContext: StreamTransformContext,
  ) {
    const normalizedFinal = normalizeOpenAiChatFinalToNormalized(payload, modelName, fallbackText);
    streamContext.id = normalizedFinal.id;
    streamContext.model = normalizedFinal.model;
    streamContext.created = normalizedFinal.created;
    return buildNormalizedFinalToOpenAiChatChunks(normalizedFinal)
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  },
  buildSyntheticChunks(normalized: NormalizedFinalResponse) {
    return buildNormalizedFinalToOpenAiChatChunks(normalized);
  },
  pullSseEvents(buffer: string) {
    return openAiChatStream.pullSseEvents(buffer);
  },
};

export type OpenAiChatTransformer = typeof openAiChatTransformer;
export type OpenAiChatParsedRequest = OpenAiChatParsedRequestModel;
export type OpenAiChatRequestEnvelope = OpenAiChatRequestEnvelopeModel;
