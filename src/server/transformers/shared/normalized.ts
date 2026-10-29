export {
  buildSyntheticOpenAiChunks,
  createClaudeDownstreamContext,
  createStreamTransformContext,
  normalizeStopReason,
  normalizeUpstreamFinalResponse,
  normalizeUpstreamStreamEvent,
  parseDownstreamChatRequest,
  pullSseEventsWithDone,
  serializeFinalResponse,
  serializeNormalizedStreamEvent,
  serializeStreamDone,
  toClaudeStopReason,
  type ClaudeDownstreamContext,
  type DownstreamFormat,
  type NormalizedFinalResponse,
  type NormalizedStreamEvent,
  type ParsedDownstreamChatRequest,
  type ParsedSseEvent,
  type StreamTransformContext,
} from './chatFormatsCore.js';
import { cloneJsonDeep } from './cloneJson.js';

export type NormalizedContentBlockType =
  | 'text'
  | 'image_url'
  | 'image_inline'
  | 'input_file'
  | 'input_audio'
  | 'output_audio'
  | 'tool_call'
  | 'tool_result'
  | 'function_response'
  | 'reasoning'
  | 'redacted_reasoning';

export type NormalizedContentBlock = {
  type: NormalizedContentBlockType;
  role?: string | null;
  text?: string | null;
  mimeType?: string | null;
  url?: string | null;
  data?: string | null;
  fileId?: string | null;
  filename?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  argumentsText?: string | null;
  result?: unknown;
  metadata?: Record<string, unknown> | null;
};

export type NormalizedUsage = {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  reasoningTokens?: number | null;
  audioInputTokens?: number | null;
  audioOutputTokens?: number | null;
  acceptedPredictionTokens?: number | null;
  rejectedPredictionTokens?: number | null;
};


export type TransformerMetadata = {
  include?: unknown;
  maxToolCalls?: number | null;
  promptCacheKey?: unknown;
  promptCacheRetention?: unknown;
  truncation?: unknown;
  serviceTier?: unknown;
  includeObfuscation?: boolean | null;
  citations?: unknown;
  annotations?: unknown;
  groundingMetadata?: unknown;
  usageMetadata?: unknown;
  geminiSafetySettings?: unknown;
  geminiImageConfig?: unknown;
  thoughtSignature?: string | null;
  thoughtSignatures?: string[];
  passthrough?: Record<string, unknown>;
};




export function createEmptyNormalizedUsage(): NormalizedUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    acceptedPredictionTokens: 0,
    rejectedPredictionTokens: 0,
  };
}

/**
 * Merge two usage readings of the SAME request.
 *
 * Every field is a snapshot of that request's totals, not an increment: Anthropic reports
 * input tokens on `message_start` and output tokens on `message_delta`, OpenAI reports once
 * at the end, Gemini on each candidate. Summing them counted the same tokens up to four
 * times (the cache fields were summed here *and* summed again by the Anthropic merge), so
 * the rule is per-field max — "the highest total any frame has reported so far".
 */
export function mergeNormalizedUsage(
  base: NormalizedUsage | undefined,
  next: NormalizedUsage | undefined,
): NormalizedUsage {
  const merged = { ...createEmptyNormalizedUsage(), ...(base || {}) };
  const incoming = next || {};
  const max = (left: unknown, right: unknown): number => Math.max(
    Number.isFinite(Number(left)) ? Number(left) : 0,
    Number.isFinite(Number(right)) ? Number(right) : 0,
  );
  return {
    promptTokens: max(merged.promptTokens, incoming.promptTokens),
    completionTokens: max(merged.completionTokens, incoming.completionTokens),
    totalTokens: max(merged.totalTokens, incoming.totalTokens),
    cachedTokens: max(merged.cachedTokens, incoming.cachedTokens),
    cacheReadTokens: max(merged.cacheReadTokens, incoming.cacheReadTokens),
    cacheCreationTokens: max(merged.cacheCreationTokens, incoming.cacheCreationTokens),
    reasoningTokens: max(merged.reasoningTokens, incoming.reasoningTokens),
    audioInputTokens: max(merged.audioInputTokens, incoming.audioInputTokens),
    audioOutputTokens: max(merged.audioOutputTokens, incoming.audioOutputTokens),
    acceptedPredictionTokens: max(merged.acceptedPredictionTokens, incoming.acceptedPredictionTokens),
    rejectedPredictionTokens: max(merged.rejectedPredictionTokens, incoming.rejectedPredictionTokens),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const cloneJsonValue = cloneJsonDeep;

const TRANSFORMER_METADATA_PASSTHROUGH_KEYS = new Set([
  'systemInstruction',
  'cachedContent',
  'toolConfig',
  'tools',
  'stopSequences',
  'responseModalities',
  'responseMimeType',
  'responseSchema',
  'candidateCount',
  'maxOutputTokens',
  'temperature',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'seed',
  'responseLogprobs',
  'logprobs',
  'thinkingConfig',
]);

export function toTransformerMetadataRecord(
  metadata: TransformerMetadata | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const record: Record<string, unknown> = {};
  if (metadata.include !== undefined) record.include = cloneJsonValue(metadata.include);
  if (metadata.maxToolCalls !== undefined) record.maxToolCalls = metadata.maxToolCalls;
  if (metadata.promptCacheKey !== undefined) record.promptCacheKey = cloneJsonValue(metadata.promptCacheKey);
  if (metadata.promptCacheRetention !== undefined) {
    record.promptCacheRetention = cloneJsonValue(metadata.promptCacheRetention);
  }
  if (metadata.truncation !== undefined) record.truncation = cloneJsonValue(metadata.truncation);
  if (metadata.serviceTier !== undefined) record.serviceTier = cloneJsonValue(metadata.serviceTier);
  if (metadata.includeObfuscation !== undefined) record.includeObfuscation = metadata.includeObfuscation;
  if (metadata.citations !== undefined) record.citations = cloneJsonValue(metadata.citations);
  if (metadata.annotations !== undefined) record.annotations = cloneJsonValue(metadata.annotations);
  if (metadata.groundingMetadata !== undefined) {
    record.groundingMetadata = cloneJsonValue(metadata.groundingMetadata);
  }
  if (metadata.usageMetadata !== undefined) {
    record.usageMetadata = cloneJsonValue(metadata.usageMetadata);
  }
  if (metadata.geminiSafetySettings !== undefined) {
    record.safetySettings = cloneJsonValue(metadata.geminiSafetySettings);
  }
  if (metadata.geminiImageConfig !== undefined) {
    record.imageConfig = cloneJsonValue(metadata.geminiImageConfig);
  }
  if (metadata.thoughtSignature !== undefined) record.thoughtSignature = metadata.thoughtSignature;
  if (metadata.thoughtSignatures !== undefined) {
    record.thoughtSignatures = cloneJsonValue(metadata.thoughtSignatures);
  }
  if (isRecord(metadata.passthrough)) {
    for (const [key, value] of Object.entries(metadata.passthrough)) {
      if (record[key] === undefined) {
        record[key] = cloneJsonValue(value);
      }
    }
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

export function fromTransformerMetadataRecord(
  value: unknown,
): TransformerMetadata | undefined {
  if (!isRecord(value)) return undefined;

  const metadata: TransformerMetadata = {};
  if (value.include !== undefined) metadata.include = cloneJsonValue(value.include);
  if (typeof value.maxToolCalls === 'number' && Number.isFinite(value.maxToolCalls)) {
    metadata.maxToolCalls = value.maxToolCalls;
  }
  if (value.promptCacheKey !== undefined) metadata.promptCacheKey = cloneJsonValue(value.promptCacheKey);
  if (value.promptCacheRetention !== undefined) {
    metadata.promptCacheRetention = cloneJsonValue(value.promptCacheRetention);
  }
  if (value.truncation !== undefined) metadata.truncation = cloneJsonValue(value.truncation);
  if (value.serviceTier !== undefined) metadata.serviceTier = cloneJsonValue(value.serviceTier);
  if (typeof value.includeObfuscation === 'boolean') metadata.includeObfuscation = value.includeObfuscation;
  if (value.citations !== undefined) metadata.citations = cloneJsonValue(value.citations);
  if (value.annotations !== undefined) metadata.annotations = cloneJsonValue(value.annotations);
  if (value.groundingMetadata !== undefined) {
    metadata.groundingMetadata = cloneJsonValue(value.groundingMetadata);
  }
  if (value.usageMetadata !== undefined) {
    metadata.usageMetadata = cloneJsonValue(value.usageMetadata);
  }
  if (value.safetySettings !== undefined) {
    metadata.geminiSafetySettings = cloneJsonValue(value.safetySettings);
  }
  if (value.imageConfig !== undefined) {
    metadata.geminiImageConfig = cloneJsonValue(value.imageConfig);
  }
  if (typeof value.thoughtSignature === 'string') metadata.thoughtSignature = value.thoughtSignature;
  if (Array.isArray(value.thoughtSignatures)) {
    metadata.thoughtSignatures = value.thoughtSignatures
      .filter((item): item is string => typeof item === 'string');
  }

  const passthroughEntries = Object.entries(value)
    .filter(([key]) => TRANSFORMER_METADATA_PASSTHROUGH_KEYS.has(key));
  if (passthroughEntries.length > 0) {
    metadata.passthrough = Object.fromEntries(
      passthroughEntries.map(([key, entry]) => [key, cloneJsonValue(entry)]),
    );
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
