import { canonicalRequestFromOpenAiBody, canonicalRequestToOpenAiChatBody } from '../../canonical/openAiRequestBridge.js';
import type { CanonicalRequestEnvelope } from '../../canonical/types.js';
import type { ProtocolParseContext } from '../../contracts.js';
import { anthropicMessagesInbound } from './inbound.js';
import { convertOpenAiBodyToAnthropicMessagesBody } from './conversion.js';

export function parseAnthropicMessagesRequestToCanonical(
  body: unknown,
  ctx?: ProtocolParseContext,
): { value?: CanonicalRequestEnvelope; error?: { statusCode: number; payload: unknown } } {
  const parsed = anthropicMessagesInbound.parse(body);
  if (parsed.error) {
    return { error: parsed.error };
  }
  if (!parsed.value) {
    return {
      error: {
        statusCode: 400,
        payload: {
          error: {
            message: 'invalid messages request',
            type: 'invalid_request_error',
          },
        },
      },
    };
  }

  return {
    value: canonicalRequestFromOpenAiBody({
      body: parsed.value.parsed.upstreamBody,
      surface: 'anthropic-messages',
      cliProfile: ctx?.cliProfile,
      operation: ctx?.operation,
      metadata: ctx?.metadata,
      passthrough: ctx?.passthrough,
      continuation: ctx?.continuation,
    }),
  };
}

export function buildCanonicalRequestToAnthropicMessagesBody(
  request: CanonicalRequestEnvelope,
): Record<string, unknown> {
  const openAiBody = canonicalRequestToOpenAiChatBody(request);
  return convertOpenAiBodyToAnthropicMessagesBody(openAiBody, request.requestedModel, request.stream);
}
