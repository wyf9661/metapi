import { createEmptyNormalizedUsage, mergeNormalizedUsage, type NormalizedUsage } from '../../shared/normalized.js';

type AnthropicRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnthropicRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: AnthropicRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function toPositiveInt(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.trunc(numberValue));
}

function resolveAnthropicUsageRecord(payload: unknown): AnthropicRecord | null {
  if (isRecord(payload) && isRecord(payload.usage)) return payload.usage;
  if (isRecord(payload)) return payload;
  return null;
}

function readEphemeralBreakdown(record: AnthropicRecord): {
  ephemeral5mInputTokens: number;
  ephemeral1hInputTokens: number;
} {
  const snake = isRecord(record.cache_creation) ? record.cache_creation : null;
  const camel = isRecord(record.cacheCreation) ? record.cacheCreation : null;

  return {
    ephemeral5mInputTokens: Math.max(
      toPositiveInt(snake?.ephemeral_5m_input_tokens),
      toPositiveInt(camel?.ephemeral5mInputTokens),
      toPositiveInt(record.ephemeral_5m_input_tokens),
      toPositiveInt(record.ephemeral5mInputTokens),
    ),
    ephemeral1hInputTokens: Math.max(
      toPositiveInt(snake?.ephemeral_1h_input_tokens),
      toPositiveInt(camel?.ephemeral1hInputTokens),
      toPositiveInt(record.ephemeral_1h_input_tokens),
      toPositiveInt(record.ephemeral1hInputTokens),
    ),
  };
}

function readServiceTier(record: AnthropicRecord): string | null {
  if (typeof record.service_tier === 'string' && record.service_tier.trim().length > 0) {
    return record.service_tier.trim();
  }
  if (typeof record.serviceTier === 'string' && record.serviceTier.trim().length > 0) {
    return record.serviceTier.trim();
  }
  return null;
}

function readInputTokens(record: AnthropicRecord): number {
  return Math.max(
    toPositiveInt(record.input_tokens),
    toPositiveInt(record.inputTokens),
    toPositiveInt(record.prompt_tokens),
    toPositiveInt(record.promptTokens),
  );
}

function readCompletionTokens(record: AnthropicRecord): number {
  return Math.max(
    toPositiveInt(record.output_tokens),
    toPositiveInt(record.outputTokens),
    toPositiveInt(record.completion_tokens),
    toPositiveInt(record.completionTokens),
  );
}

function readTotalTokens(record: AnthropicRecord): number {
  return Math.max(
    toPositiveInt(record.total_tokens),
    toPositiveInt(record.totalTokens),
  );
}

function readCacheReadTokens(record: AnthropicRecord): {
  cacheReadInputTokens: number;
  cachedTokens: number;
  hasCachedTokensAlias: boolean;
  hasExplicitCacheReadField: boolean;
} {
  const cachedTokens = Math.max(
    toPositiveInt(record.cached_tokens),
    toPositiveInt(record.cachedTokens),
  );
  const cacheReadInputTokens = Math.max(
    toPositiveInt(record.cache_read_input_tokens),
    toPositiveInt(record.cacheReadInputTokens),
    toPositiveInt(record.cacheReadTokens),
    cachedTokens,
  );

  return {
    cacheReadInputTokens,
    cachedTokens: Math.max(cachedTokens, cacheReadInputTokens),
    hasCachedTokensAlias: hasOwn(record, 'cached_tokens') || hasOwn(record, 'cachedTokens'),
    hasExplicitCacheReadField: (
      hasOwn(record, 'cache_read_input_tokens')
      || hasOwn(record, 'cacheReadInputTokens')
      || hasOwn(record, 'cacheReadTokens')
    ),
  };
}

function readCacheCreationInputTokens(
  record: AnthropicRecord,
  breakdown: { ephemeral5mInputTokens: number; ephemeral1hInputTokens: number },
): number {
  return Math.max(
    toPositiveInt(record.cache_creation_input_tokens),
    toPositiveInt(record.cacheCreationInputTokens),
    toPositiveInt(record.cacheCreationTokens),
    breakdown.ephemeral5mInputTokens + breakdown.ephemeral1hInputTokens,
  );
}

function readPromptTokensIncludeCache(record: AnthropicRecord, cacheRead: {
  hasCachedTokensAlias: boolean;
  hasExplicitCacheReadField: boolean;
}): boolean | null {
  if (typeof record.promptTokensIncludeCache === 'boolean') {
    return record.promptTokensIncludeCache;
  }
  if (typeof record.prompt_tokens_include_cache === 'boolean') {
    return record.prompt_tokens_include_cache;
  }

  if (cacheRead.hasCachedTokensAlias && !cacheRead.hasExplicitCacheReadField) {
    return true;
  }

  if (
    cacheRead.hasExplicitCacheReadField
    || hasOwn(record, 'cache_creation_input_tokens')
    || hasOwn(record, 'cacheCreationInputTokens')
    || hasOwn(record, 'cacheCreationTokens')
    || hasOwn(record, 'cache_creation')
    || hasOwn(record, 'cacheCreation')
  ) {
    return false;
  }

  return null;
}

export type AnthropicUsageMetadata = {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  ephemeral5mInputTokens: number;
  ephemeral1hInputTokens: number;
  promptTokensIncludingCache: number;
  promptTokensIncludeCache?: boolean | null;
  serviceTier?: string | null;
  cachedTokens?: number;
};

export type AnthropicNormalizedUsage = NormalizedUsage & AnthropicUsageMetadata & {
  promptTokensIncludeCache?: boolean | null;
};

type AnthropicUsageSummary = {
  inputTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  ephemeral5mInputTokens: number;
  ephemeral1hInputTokens: number;
  promptTokensIncludingCache: number;
  promptTokensIncludeCache: boolean | null;
  serviceTier: string | null;
  cachedTokens: number;
};

function summarizeAnthropicUsage(payload: unknown): AnthropicUsageSummary {
  const record = resolveAnthropicUsageRecord(payload);
  if (!record) {
    return {
      inputTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      ephemeral5mInputTokens: 0,
      ephemeral1hInputTokens: 0,
      promptTokensIncludingCache: 0,
      promptTokensIncludeCache: null,
      serviceTier: null,
      cachedTokens: 0,
    };
  }

  const breakdown = readEphemeralBreakdown(record);
  const cacheRead = readCacheReadTokens(record);
  const cacheCreationInputTokens = readCacheCreationInputTokens(record, breakdown);
  const promptTokensIncludeCache = readPromptTokensIncludeCache(record, cacheRead);

  let inputTokens = readInputTokens(record);
  const completionTokens = readCompletionTokens(record);

  const explicitPromptTokensIncludingCache = Math.max(
    toPositiveInt(record.promptTokensIncludingCache),
    toPositiveInt(record.prompt_tokens_including_cache),
  );

  let promptTokensIncludingCache = explicitPromptTokensIncludingCache;
  if (promptTokensIncludingCache <= 0) {
    if (promptTokensIncludeCache === true) {
      promptTokensIncludingCache = inputTokens;
    } else if (promptTokensIncludeCache === false) {
      promptTokensIncludingCache = inputTokens + cacheRead.cacheReadInputTokens + cacheCreationInputTokens;
    } else {
      promptTokensIncludingCache = Math.max(
        inputTokens,
        inputTokens + cacheRead.cacheReadInputTokens + cacheCreationInputTokens,
      );
    }
  }

  if (inputTokens <= 0 && promptTokensIncludingCache > 0) {
    inputTokens = Math.max(
      promptTokensIncludingCache - cacheRead.cacheReadInputTokens - cacheCreationInputTokens,
      0,
    );
  }

  return {
    inputTokens,
    completionTokens,
    totalTokens: Math.max(
      readTotalTokens(record),
      promptTokensIncludingCache + completionTokens,
    ),
    cacheReadInputTokens: cacheRead.cacheReadInputTokens,
    cacheCreationInputTokens,
    ephemeral5mInputTokens: breakdown.ephemeral5mInputTokens,
    ephemeral1hInputTokens: breakdown.ephemeral1hInputTokens,
    promptTokensIncludingCache,
    promptTokensIncludeCache,
    serviceTier: readServiceTier(record),
    cachedTokens: cacheRead.cachedTokens,
  };
}

export function extractAnthropicUsage(payload: unknown): NormalizedUsage {
  const summary = summarizeAnthropicUsage(payload);
  return {
    promptTokens: summary.promptTokensIncludingCache,
    completionTokens: summary.completionTokens,
    totalTokens: summary.totalTokens,
    cachedTokens: summary.cacheReadInputTokens,
    cacheReadTokens: summary.cacheReadInputTokens,
    cacheCreationTokens: summary.cacheCreationInputTokens,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    acceptedPredictionTokens: 0,
    rejectedPredictionTokens: 0,
    cacheReadInputTokens: summary.cacheReadInputTokens,
    cacheCreationInputTokens: summary.cacheCreationInputTokens,
    ephemeral5mInputTokens: summary.ephemeral5mInputTokens,
    ephemeral1hInputTokens: summary.ephemeral1hInputTokens,
    promptTokensIncludingCache: summary.promptTokensIncludingCache,
    promptTokensIncludeCache: summary.promptTokensIncludeCache,
    serviceTier: summary.serviceTier,
  } as AnthropicNormalizedUsage;
}

export function extractAnthropicUsageMetadata(payload: unknown): AnthropicUsageMetadata {
  const summary = summarizeAnthropicUsage(payload);
  return {
    cacheReadInputTokens: summary.cacheReadInputTokens,
    cacheCreationInputTokens: summary.cacheCreationInputTokens,
    ephemeral5mInputTokens: summary.ephemeral5mInputTokens,
    ephemeral1hInputTokens: summary.ephemeral1hInputTokens,
    promptTokensIncludingCache: summary.promptTokensIncludingCache,
    promptTokensIncludeCache: summary.promptTokensIncludeCache,
    serviceTier: summary.serviceTier,
    cachedTokens: summary.cachedTokens,
  };
}

export function toAnthropicUsagePayload(usage: unknown): Record<string, unknown> {
  const summary = summarizeAnthropicUsage(usage);
  const shouldDeriveInputTokens = (
    summary.cacheReadInputTokens > 0
    || summary.cacheCreationInputTokens > 0
    || summary.promptTokensIncludeCache === true
    || summary.promptTokensIncludingCache !== summary.inputTokens
  );
  const inputTokens = shouldDeriveInputTokens
    ? Math.max(
      summary.promptTokensIncludingCache - summary.cacheReadInputTokens - summary.cacheCreationInputTokens,
      0,
    )
    : summary.inputTokens;
  const payload: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: summary.completionTokens,
  };

  if (summary.cacheReadInputTokens > 0) {
    payload.cache_read_input_tokens = summary.cacheReadInputTokens;
  }
  if (summary.cacheCreationInputTokens > 0) {
    payload.cache_creation_input_tokens = summary.cacheCreationInputTokens;
  }
  if (summary.ephemeral5mInputTokens > 0 || summary.ephemeral1hInputTokens > 0) {
    payload.cache_creation = {
      ephemeral_5m_input_tokens: summary.ephemeral5mInputTokens,
      ephemeral_1h_input_tokens: summary.ephemeral1hInputTokens,
    };
  }
  if (summary.serviceTier) {
    payload.service_tier = summary.serviceTier;
  }

  return payload;
}

function mergeAnthropicUsage(
  base: NormalizedUsage | undefined,
  next: NormalizedUsage | undefined,
): AnthropicNormalizedUsage {
  const mergedBase = mergeNormalizedUsage(base, next) as AnthropicNormalizedUsage;
  const baseUsage = (base ?? {}) as AnthropicNormalizedUsage;
  const nextUsage = (next ?? {}) as AnthropicNormalizedUsage;

  const basePromptTokensIncludingCache = toPositiveInt(baseUsage.promptTokensIncludingCache ?? baseUsage.promptTokens);
  const nextPromptTokensIncludingCache = toPositiveInt(nextUsage.promptTokensIncludingCache ?? nextUsage.promptTokens);

  return {
    ...mergedBase,
    cacheReadInputTokens: Math.max(toPositiveInt(baseUsage.cacheReadInputTokens), toPositiveInt(nextUsage.cacheReadInputTokens)),
    cacheCreationInputTokens: Math.max(toPositiveInt(baseUsage.cacheCreationInputTokens), toPositiveInt(nextUsage.cacheCreationInputTokens)),
    ephemeral5mInputTokens: Math.max(toPositiveInt(baseUsage.ephemeral5mInputTokens), toPositiveInt(nextUsage.ephemeral5mInputTokens)),
    ephemeral1hInputTokens: Math.max(toPositiveInt(baseUsage.ephemeral1hInputTokens), toPositiveInt(nextUsage.ephemeral1hInputTokens)),
    promptTokensIncludingCache: Math.max(basePromptTokensIncludingCache, nextPromptTokensIncludingCache),
    promptTokensIncludeCache: nextUsage.promptTokensIncludeCache ?? baseUsage.promptTokensIncludeCache ?? null,
    serviceTier: typeof nextUsage.serviceTier === 'string'
      ? nextUsage.serviceTier
      : (typeof baseUsage.serviceTier === 'string' ? baseUsage.serviceTier : null),
    cachedTokens: Math.max(toPositiveInt(baseUsage.cachedTokens), toPositiveInt(nextUsage.cachedTokens)),
  };
}

export const anthropicMessagesUsage = {
  empty: createEmptyNormalizedUsage,
  fromPayload: extractAnthropicUsage,
  metadataFromPayload: extractAnthropicUsageMetadata,
  toPayload: toAnthropicUsagePayload,
  merge: mergeAnthropicUsage,
};
