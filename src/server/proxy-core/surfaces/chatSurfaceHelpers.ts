import { type DownstreamFormat } from '../../transformers/shared/normalized.js';
import { openAiChatTransformer } from '../../transformers/openai/chat/index.js';
import { geminiGenerateContentTransformer } from '../../transformers/gemini/generate-content/index.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isGeminiNativeRuntimePath(path: string): boolean {
  return /\/v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(path);
}

export function buildOpenAiFinalFromGeminiNativePayload(
  payload: unknown,
  modelName: string,
  fallbackText = '',
) {
  const aggregate = geminiGenerateContentTransformer.aggregator.createState();
  for (const item of geminiGenerateContentTransformer.stream.parseJsonArrayPayload(payload)) {
    geminiGenerateContentTransformer.aggregator.apply(aggregate, item);
  }
  const geminiFinal = geminiGenerateContentTransformer.outbound.serializeAggregateResponse(aggregate);
  return openAiChatTransformer.transformFinalResponse(geminiFinal, modelName, fallbackText);
}

export function buildOpenAiStreamLinesFromGeminiNativeSse(
  rawText: string,
  modelName: string,
): { lines: string[]; finalPayload: Record<string, unknown> } {
  const aggregate = geminiGenerateContentTransformer.stream.createAggregateState();
  const parsed = geminiGenerateContentTransformer.stream.parseSsePayloads(rawText);
  for (const payload of parsed.events) {
    geminiGenerateContentTransformer.stream.applyAggregate(aggregate, payload);
  }

  const geminiFinal = geminiGenerateContentTransformer.outbound.serializeAggregateResponse(aggregate);
  const normalizedFinal = openAiChatTransformer.transformFinalResponse(geminiFinal, modelName, rawText);
  const streamContext = openAiChatTransformer.createStreamContext(modelName);
  streamContext.id = normalizedFinal.id;
  streamContext.model = normalizedFinal.model;
  streamContext.created = normalizedFinal.created;
  return {
    finalPayload: geminiFinal,
    lines: [
      ...openAiChatTransformer.buildSyntheticChunks(normalizedFinal)
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
      'data: [DONE]\n\n',
    ],
  };
}

export function finalizeRetryAsUpstreamFailure(status: number, message: string) {
  return {
    action: 'respond' as const,
    status,
    payload: {
      error: {
        message,
        type: 'upstream_error' as const,
      },
    },
  };
}

export function finalizeRetryAsExecutionFailure(message: string) {
  return {
    action: 'respond' as const,
    status: 502,
    payload: {
      error: {
        message: `Upstream error: ${message}`,
        type: 'upstream_error' as const,
      },
    },
  };
}

export function deriveCodexSessionCacheKey(input: {
  downstreamFormat: DownstreamFormat | 'responses';
  body: unknown;
  requestedModel: string;
  proxyToken: string | null;
}): string | null {
  if (isRecord(input.body)) {
    if (input.downstreamFormat === 'claude' && isRecord(input.body.metadata)) {
      const userId = asTrimmedString(input.body.metadata.user_id);
      if (userId) return `${input.requestedModel}:claude:${userId}`;
    }
    const promptCacheKey = asTrimmedString(input.body.prompt_cache_key);
    if (promptCacheKey) return `${input.requestedModel}:responses:${promptCacheKey}`;
  }

  const proxyToken = asTrimmedString(input.proxyToken);
  if (proxyToken) {
    return `${input.requestedModel}:proxy:${proxyToken}`;
  }

  return null;
}
