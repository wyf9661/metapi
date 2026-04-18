import {
  buildSyntheticOpenAiChunks,
  normalizeUpstreamFinalResponse,
  serializeFinalResponse,
  type NormalizedFinalResponse,
} from '../../shared/normalized.js';
import { extractChatChoices, extractChatResponseExtras } from './helpers.js';
import type { OpenAiChatNormalizedFinalResponse } from './model.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeUsagePayload(
  usage: unknown,
  normalized: OpenAiChatNormalizedFinalResponse,
): Record<string, unknown> | undefined {
  const merged = isRecord(usage) ? { ...usage } : {};
  const usagePayload = normalized.usagePayload && isRecord(normalized.usagePayload)
    ? normalized.usagePayload
    : null;

  if (usagePayload) {
    for (const [key, value] of Object.entries(usagePayload)) {
      if (key === 'prompt_tokens' || key === 'completion_tokens' || key === 'total_tokens') continue;
      if (merged[key] === undefined) merged[key] = value;
    }
  }

  if (normalized.usageDetails?.prompt_tokens_details) {
    merged.prompt_tokens_details = normalized.usageDetails.prompt_tokens_details;
  }
  if (normalized.usageDetails?.completion_tokens_details) {
    merged.completion_tokens_details = normalized.usageDetails.completion_tokens_details;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function normalizeOpenAiChatFinalToNormalized(
  payload: unknown,
  modelName: string,
  fallbackText = '',
): OpenAiChatNormalizedFinalResponse {
  const choices = extractChatChoices(payload);
  const primaryChoice = choices[0];
  return {
    ...normalizeUpstreamFinalResponse(payload, modelName, fallbackText),
    ...(choices.length > 0 ? { choices } : {}),
    ...(primaryChoice?.annotations?.length ? { annotations: primaryChoice.annotations } : {}),
    ...(primaryChoice?.citations?.length ? { citations: primaryChoice.citations } : {}),
    ...extractChatResponseExtras(payload),
  };
}

export function buildNormalizedFinalToOpenAiChatPayload(
  normalized: NormalizedFinalResponse,
  usage?: unknown,
) {
  const chatNormalized = normalized as OpenAiChatNormalizedFinalResponse;
  const normalizedUsage = isRecord(usage)
    && typeof usage.promptTokens === 'number'
    && typeof usage.completionTokens === 'number'
    && typeof usage.totalTokens === 'number'
    ? {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      }
    : {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
  const payload = serializeFinalResponse(
    'openai',
    normalized,
    normalizedUsage,
  ) as Record<string, unknown>;

  const choices = Array.isArray(chatNormalized.choices) && chatNormalized.choices.length > 0
    ? chatNormalized.choices
    : [{
      index: 0,
      content: normalized.content,
      reasoningContent: normalized.reasoningContent,
      toolCalls: normalized.toolCalls,
      finishReason: normalized.toolCalls.length > 0 ? 'tool_calls' : normalized.finishReason,
      annotations: chatNormalized.annotations,
      citations: chatNormalized.citations,
    }];

  payload.choices = choices.map((choice) => {
    const message: Record<string, unknown> = {
      role: choice.role || 'assistant',
      content: choice.content,
    };
    if (choice.reasoningContent) {
      message.reasoning_content = choice.reasoningContent;
    }
    if (Array.isArray(choice.toolCalls) && choice.toolCalls.length > 0) {
      message.tool_calls = choice.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      }));
      if (!choice.content) {
        message.content = '';
      }
    }
    if (Array.isArray(choice.annotations) && choice.annotations.length > 0) {
      message.annotations = choice.annotations;
    }

    return {
      index: choice.index,
      message,
      finish_reason: choice.finishReason || (choice.toolCalls?.length ? 'tool_calls' : 'stop'),
    };
  }).sort((left, right) => left.index - right.index);

  if (Array.isArray(chatNormalized.citations) && chatNormalized.citations.length > 0) {
    payload.citations = chatNormalized.citations;
  }

  const mergedUsage = mergeUsagePayload(payload.usage, chatNormalized);
  if (mergedUsage) {
    payload.usage = {
      ...(isRecord(payload.usage) ? payload.usage : {}),
      ...mergedUsage,
    };
  }

  return payload;
}

export function buildNormalizedFinalToOpenAiChatChunks(normalized: NormalizedFinalResponse) {
  const chatNormalized = normalized as OpenAiChatNormalizedFinalResponse;
  const choices = Array.isArray(chatNormalized.choices) && chatNormalized.choices.length > 0
    ? chatNormalized.choices
    : undefined;
  const chunks = choices && choices.length > 1
    ? [
      {
        id: normalized.id,
        object: 'chat.completion.chunk',
        created: normalized.created,
        model: normalized.model,
        choices: choices.map((choice) => {
          const toolCalls = Array.isArray(choice.toolCalls) ? choice.toolCalls : [];
          const delta: Record<string, unknown> = {
            role: choice.role || 'assistant',
            content: choice.content || '',
          };
          if (choice.reasoningContent) delta.reasoning_content = choice.reasoningContent;
          if (toolCalls.length > 0) {
            delta.tool_calls = toolCalls.map((toolCall, toolIndex) => ({
              index: toolIndex,
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: toolCall.arguments,
              },
            }));
          }
          if (Array.isArray(choice.annotations) && choice.annotations.length > 0) {
            delta.annotations = choice.annotations;
          }
          return {
            index: choice.index,
            delta,
            finish_reason: null,
          };
        }).sort((left, right) => left.index - right.index),
      },
      {
        id: normalized.id,
        object: 'chat.completion.chunk',
        created: normalized.created,
        model: normalized.model,
        choices: choices.map((choice) => {
          const toolCalls = Array.isArray(choice.toolCalls) ? choice.toolCalls : [];
          return {
            index: choice.index,
            delta: {},
            finish_reason: choice.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
          };
        }).sort((left, right) => left.index - right.index),
      },
    ]
    : buildSyntheticOpenAiChunks(normalized);
  if (chunks.length <= 0) return chunks;

  if (Array.isArray(chatNormalized.citations) && chatNormalized.citations.length > 0) {
    chunks[0] = {
      ...chunks[0],
      citations: chatNormalized.citations,
    };
  }

  if (!choices && Array.isArray(chatNormalized.annotations) && chatNormalized.annotations.length > 0) {
    const firstChunk = isRecord(chunks[0]) ? chunks[0] : null;
    const firstChoice = firstChunk && Array.isArray(firstChunk.choices) ? firstChunk.choices[0] : null;
    if (isRecord(firstChoice) && isRecord(firstChoice.delta)) {
      firstChoice.delta.annotations = chatNormalized.annotations;
    }
  }

  return chunks;
}

export const openAiChatResponseBridge = {
  normalizeFinal: normalizeOpenAiChatFinalToNormalized,
  serializeFinal: buildNormalizedFinalToOpenAiChatPayload,
  buildSyntheticChunks: buildNormalizedFinalToOpenAiChatChunks,
};

export const openAiChatOutbound = openAiChatResponseBridge;

export {
  buildNormalizedFinalToOpenAiChatChunks as buildSyntheticOpenAiChatChunksFromNormalized,
  buildNormalizedFinalToOpenAiChatPayload as serializeOpenAiChatFinalPayload,
  normalizeOpenAiChatFinalToNormalized as normalizeOpenAiChatFinalPayload,
};
