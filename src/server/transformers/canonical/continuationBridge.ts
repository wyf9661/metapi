import type { CanonicalContinuation } from './types.js';

export const OPENAI_CONTINUATION_TURN_STATE_METADATA_KEY = 'metapi_turn_state';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeCanonicalContinuation(
  continuation: CanonicalContinuation | undefined,
): CanonicalContinuation | undefined {
  if (!continuation) return undefined;

  const normalized: CanonicalContinuation = {
    ...(asTrimmedString(continuation.sessionId) ? { sessionId: asTrimmedString(continuation.sessionId) } : {}),
    ...(asTrimmedString(continuation.previousResponseId)
      ? { previousResponseId: asTrimmedString(continuation.previousResponseId) }
      : {}),
    ...(asTrimmedString(continuation.promptCacheKey)
      ? { promptCacheKey: asTrimmedString(continuation.promptCacheKey) }
      : {}),
    ...(asTrimmedString(continuation.turnState) ? { turnState: asTrimmedString(continuation.turnState) } : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function readOpenAiCompatibleContinuation(
  body: Record<string, unknown>,
  existing?: CanonicalContinuation,
): CanonicalContinuation | undefined {
  const metadata = isRecord(body.metadata) ? body.metadata : null;
  return normalizeCanonicalContinuation({
    ...(existing ?? {}),
    ...(asTrimmedString(body.session_id)
      ? { sessionId: asTrimmedString(body.session_id) }
      : {}),
    ...(asTrimmedString(body.conversation_id)
      ? { sessionId: asTrimmedString(body.conversation_id) }
      : {}),
    ...(metadata && asTrimmedString(metadata.user_id)
      ? { sessionId: asTrimmedString(metadata.user_id) }
      : {}),
    ...(asTrimmedString(body.previous_response_id)
      ? { previousResponseId: asTrimmedString(body.previous_response_id) }
      : {}),
    ...(asTrimmedString(body.prompt_cache_key)
      ? { promptCacheKey: asTrimmedString(body.prompt_cache_key) }
      : {}),
    ...(metadata && asTrimmedString(metadata[OPENAI_CONTINUATION_TURN_STATE_METADATA_KEY])
      ? { turnState: asTrimmedString(metadata[OPENAI_CONTINUATION_TURN_STATE_METADATA_KEY]) }
      : {}),
  });
}

export function buildOpenAiCompatibleMetadataWithContinuation(
  metadata: Record<string, unknown>,
  continuation: CanonicalContinuation | undefined,
): Record<string, unknown> {
  const normalized = normalizeCanonicalContinuation(continuation);
  const nextMetadata: Record<string, unknown> = { ...metadata };

  if (!normalized) return nextMetadata;
  if (!('user_id' in nextMetadata) && normalized.sessionId) {
    nextMetadata.user_id = normalized.sessionId;
  }
  if (!(OPENAI_CONTINUATION_TURN_STATE_METADATA_KEY in nextMetadata) && normalized.turnState) {
    nextMetadata[OPENAI_CONTINUATION_TURN_STATE_METADATA_KEY] = normalized.turnState;
  }
  return nextMetadata;
}

export function applyOpenAiCompatibleContinuation(
  body: Record<string, unknown>,
  continuation: CanonicalContinuation | undefined,
  metadata: Record<string, unknown> = {},
): void {
  const normalized = normalizeCanonicalContinuation(continuation);
  const nextMetadata = buildOpenAiCompatibleMetadataWithContinuation(metadata, normalized);

  if (Object.keys(nextMetadata).length > 0) {
    body.metadata = nextMetadata;
  }
  if (normalized?.promptCacheKey) {
    body.prompt_cache_key = normalized.promptCacheKey;
  }
  if (normalized?.previousResponseId) {
    body.previous_response_id = normalized.previousResponseId;
  }
}
