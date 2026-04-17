import { canonicalRequestFromOpenAiBody, canonicalRequestToOpenAiChatBody } from '../../canonical/openAiRequestBridge.js';
import type { CanonicalRequestEnvelope } from '../../canonical/types.js';
import type { ProtocolParseContext } from '../../contracts.js';
import { openAiChatInbound } from './inbound.js';

export function parseOpenAiChatRequestToCanonical(
  body: unknown,
  ctx?: ProtocolParseContext,
): { value?: CanonicalRequestEnvelope; error?: { statusCode: number; payload: unknown } } {
  const parsed = openAiChatInbound.parse(body);
  if (parsed.error) {
    return { error: parsed.error };
  }
  if (!parsed.value) {
    return {
      error: {
        statusCode: 400,
        payload: {
          error: {
            message: 'invalid chat request',
            type: 'invalid_request_error',
          },
        },
      },
    };
  }

  return {
    value: canonicalRequestFromOpenAiBody({
      body: parsed.value.parsed.upstreamBody,
      surface: 'openai-chat',
      cliProfile: ctx?.cliProfile,
      operation: ctx?.operation,
      metadata: ctx?.metadata,
      passthrough: ctx?.passthrough,
      continuation: ctx?.continuation,
    }),
  };
}

export function buildCanonicalRequestToOpenAiChatBody(
  request: CanonicalRequestEnvelope,
): Record<string, unknown> {
  return canonicalRequestToOpenAiChatBody(request);
}
