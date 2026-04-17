import { canonicalRequestFromOpenAiBody, canonicalRequestToOpenAiChatBody } from '../../canonical/openAiRequestBridge.js';
import type { CanonicalRequestEnvelope } from '../../canonical/types.js';
import type { ProtocolParseContext } from '../../contracts.js';
import {
  convertOpenAiBodyToResponsesBody,
  convertResponsesBodyToOpenAiBody,
} from './conversion.js';
import { openAiResponsesInbound } from './inbound.js';

function normalizeIncludeList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

export function parseOpenAiResponsesRequestToCanonical(
  body: unknown,
  ctx?: ProtocolParseContext,
): { value?: CanonicalRequestEnvelope; error?: { statusCode: number; payload: unknown } } {
  const parsed = openAiResponsesInbound.parse(body, {
    defaultEncryptedReasoningInclude: ctx?.defaultEncryptedReasoningInclude,
  });
  if (parsed.error) {
    return { error: parsed.error };
  }
  if (!parsed.value) {
    return {
      error: {
        statusCode: 400,
        payload: {
          error: {
            message: 'invalid responses request',
            type: 'invalid_request_error',
          },
        },
      },
    };
  }

  const responsesBody = parsed.value.parsed.normalizedBody;
  const openAiBody = convertResponsesBodyToOpenAiBody(
    responsesBody,
    typeof responsesBody.model === 'string' ? responsesBody.model : parsed.value.model,
    responsesBody.stream === true,
    { defaultEncryptedReasoningInclude: ctx?.defaultEncryptedReasoningInclude },
  );

  return {
    value: canonicalRequestFromOpenAiBody({
      body: openAiBody,
      surface: 'openai-responses',
      cliProfile: ctx?.cliProfile,
      operation: ctx?.operation,
      metadata: ctx?.metadata,
      passthrough: ctx?.passthrough,
      continuation: ctx?.continuation,
    }),
  };
}

export function buildCanonicalRequestToOpenAiResponsesBody(
  request: CanonicalRequestEnvelope,
): Record<string, unknown> {
  const openAiBody = canonicalRequestToOpenAiChatBody(request);
  if (request.reasoning) {
    openAiBody.reasoning = {
      ...(request.reasoning.effort ? { effort: request.reasoning.effort } : {}),
      ...(request.reasoning.budgetTokens !== undefined ? { budget_tokens: request.reasoning.budgetTokens } : {}),
      ...(request.reasoning.summary ? { summary: request.reasoning.summary } : {}),
    };
  }
  const body = convertOpenAiBodyToResponsesBody(openAiBody, request.requestedModel, request.stream);
  const mergedInclude = Array.from(new Set([
    'reasoning.encrypted_content',
    ...normalizeIncludeList(body.include),
  ]));
  return {
    ...body,
    include: mergedInclude,
    store: false,
  };
}
