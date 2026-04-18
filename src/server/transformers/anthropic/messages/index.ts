import type { CanonicalRequestEnvelope } from '../../canonical/types.js';
import type { ProtocolBuildContext, ProtocolParseContext } from '../../contracts.js';
import { type NormalizedFinalResponse, type NormalizedStreamEvent, type ParsedDownstreamChatRequest, type StreamTransformContext, type ClaudeDownstreamContext } from '../../shared/normalized.js';
import { createChatEndpointStrategy } from '../../shared/chatEndpointStrategy.js';
import { anthropicMessagesInbound } from './inbound.js';
import {
  buildCanonicalRequestToAnthropicMessagesBody,
  parseAnthropicMessagesRequestToCanonical,
} from './requestBridge.js';
import {
  anthropicMessagesResponseBridge,
  buildNormalizedFinalToAnthropicMessagesBody,
  normalizeAnthropicMessagesFinalToNormalized,
} from './responseBridge.js';
import { anthropicMessagesStream, consumeAnthropicSseEvent } from './streamBridge.js';
import { anthropicMessagesUsage } from './usage.js';
import { createAnthropicMessagesAggregateState } from './aggregator.js';
import {
  isMessagesRequiredError,
  shouldRetryNormalizedMessagesBody,
} from './compatibility.js';
export {
  ANTHROPIC_RAW_SSE_EVENT_NAMES,
  consumeAnthropicSseEvent,
  isAnthropicRawSseEventName,
  serializeAnthropicFinalAsStream,
  serializeAnthropicUpstreamFinalAsStream,
  serializeAnthropicRawSseEvent,
  syncAnthropicRawStreamStateFromEvent,
} from './streamBridge.js';

export const anthropicMessagesTransformer = {
  protocol: 'anthropic/messages' as const,
  inbound: anthropicMessagesInbound,
  outbound: anthropicMessagesResponseBridge,
  stream: anthropicMessagesStream,
  usage: anthropicMessagesUsage,
  compatibility: {
    createEndpointStrategy: createChatEndpointStrategy,
    shouldRetryNormalizedBody: shouldRetryNormalizedMessagesBody,
    isMessagesRequiredError,
  },
  aggregator: {
    createState: createAnthropicMessagesAggregateState,
  },
  parseRequest(
    body: unknown,
    ctx?: ProtocolParseContext,
  ): { value?: CanonicalRequestEnvelope; error?: { statusCode: number; payload: unknown } } {
    return parseAnthropicMessagesRequestToCanonical(body, ctx);
  },
  buildProtocolRequest(
    request: CanonicalRequestEnvelope,
    _ctx?: ProtocolBuildContext,
  ): Record<string, unknown> {
    return buildCanonicalRequestToAnthropicMessagesBody(request);
  },
  transformRequest(body: unknown): ReturnType<typeof anthropicMessagesInbound.parse> {
    return anthropicMessagesInbound.parse(body);
  },
  createStreamContext(modelName: string): StreamTransformContext {
    return anthropicMessagesStream.createContext(modelName);
  },
  createDownstreamContext(): ClaudeDownstreamContext {
    return anthropicMessagesStream.createDownstreamContext();
  },
  transformFinalResponse(payload: unknown, modelName: string, fallbackText = ''): NormalizedFinalResponse {
    return normalizeAnthropicMessagesFinalToNormalized(payload, modelName, fallbackText);
  },
  transformStreamEvent(payload: unknown, context: StreamTransformContext, modelName: string): NormalizedStreamEvent {
    return anthropicMessagesStream.normalizeEvent(payload, context, modelName);
  },
  serializeStreamEvent(
    event: NormalizedStreamEvent,
    context: StreamTransformContext,
    claudeContext: ClaudeDownstreamContext,
  ): string[] {
    return anthropicMessagesStream.serializeEvent(event, context, claudeContext);
  },
  serializeDone(
    context: StreamTransformContext,
    claudeContext: ClaudeDownstreamContext,
  ): string[] {
    return anthropicMessagesStream.serializeDone(context, claudeContext);
  },
  serializeFinalResponse(
    normalized: NormalizedFinalResponse,
    usage: Parameters<typeof buildNormalizedFinalToAnthropicMessagesBody>[1],
  ) {
    return buildNormalizedFinalToAnthropicMessagesBody(normalized, usage);
  },
  serializeUpstreamFinalAsStream(
    payload: unknown,
    modelName: string,
    fallbackText: string,
    streamContext: StreamTransformContext,
    claudeContext: ClaudeDownstreamContext,
  ) {
    return anthropicMessagesStream.serializeUpstreamFinalAsStream(
      payload,
      modelName,
      fallbackText,
      normalizeAnthropicMessagesFinalToNormalized,
      streamContext,
      claudeContext,
    );
  },
  consumeSseEventBlock(
    eventBlock: { event: string; data: string },
    streamContext: StreamTransformContext,
    claudeContext: ClaudeDownstreamContext,
    modelName: string,
  ) {
    return consumeAnthropicSseEvent(
      eventBlock,
      streamContext,
      claudeContext,
      modelName,
    );
  },
  pullSseEvents(buffer: string) {
    return anthropicMessagesStream.pullSseEvents(buffer);
  },
};

export type AnthropicMessagesTransformer = typeof anthropicMessagesTransformer;
export type AnthropicMessagesParsedRequest = ParsedDownstreamChatRequest;
