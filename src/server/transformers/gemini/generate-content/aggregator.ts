import { cloneJsonDeep } from '../../shared/cloneJson.js';
type GeminiRecord = Record<string, unknown>;

function isRecord(value: unknown): value is GeminiRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const cloneJsonValue = cloneJsonDeep;

function stableSerialize(value: unknown): string {
  return JSON.stringify(value);
}

function mergeJsonArrays(existing: unknown[], incoming: unknown[]): unknown[] {
  const merged = existing.map((item) => cloneJsonValue(item));
  const seen = new Set(merged.map((item) => stableSerialize(item)));
  for (const item of incoming) {
    const cloned = cloneJsonValue(item);
    const serialized = stableSerialize(cloned);
    if (seen.has(serialized)) continue;
    seen.add(serialized);
    merged.push(cloned);
  }
  return merged;
}

function mergeJsonValues(existing: unknown, incoming: unknown): unknown {
  if (incoming === undefined) return cloneJsonValue(existing);
  if (existing === undefined) return cloneJsonValue(incoming);
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return mergeJsonArrays(existing, incoming);
  }
  if (isRecord(existing) && isRecord(incoming)) {
    return mergeJsonRecords(existing, incoming);
  }
  return cloneJsonValue(incoming);
}

function mergeJsonRecords(existing: GeminiRecord, incoming: GeminiRecord): GeminiRecord {
  const merged: GeminiRecord = Object.fromEntries(
    Object.entries(existing).map(([key, value]) => [key, cloneJsonValue(value)]),
  );

  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = mergeJsonValues(merged[key], value);
  }

  return merged;
}

function pushUniqueJson(target: GeminiRecord[], incoming: unknown): void {
  if (!isRecord(incoming)) return;
  const serialized = stableSerialize(incoming);
  if (target.some((item) => stableSerialize(item) === serialized)) return;
  target.push(cloneJsonValue(incoming));
}

function isTextPart(value: unknown): value is GeminiRecord & { text: string } {
  return isRecord(value) && typeof value.text === 'string';
}

function partComparableShape(value: GeminiRecord & { text: string }): string {
  const { text: _text, ...rest } = value;
  return stableSerialize(rest);
}

function appendPart(target: GeminiRecord[], incoming: unknown): void {
  if (!isRecord(incoming)) return;
  const next = cloneJsonValue(incoming);
  if (isTextPart(next)) {
    for (let index = target.length - 1; index >= 0; index -= 1) {
      const existing = target[index];
      if (!isTextPart(existing)) continue;
      if (partComparableShape(existing) !== partComparableShape(next)) continue;
      existing.text = `${existing.text}${next.text}`;
      return;
    }
  }
  target.push(next);
}

function collectPartsFromPayload(payload: unknown): GeminiRecord[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => collectPartsFromPayload(item));
  }
  if (!isRecord(payload)) return [];

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const parts: GeminiRecord[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const content = isRecord(candidate.content) ? candidate.content : null;
    if (!content || !Array.isArray(content.parts)) continue;
    for (const part of content.parts) {
      if (isRecord(part)) parts.push(cloneJsonValue(part));
    }
  }
  return parts;
}

function updateIfDefined<T extends keyof GeminiGenerateContentUsageSummary>(
  usage: GeminiGenerateContentUsageSummary,
  key: T,
  value: unknown,
): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    usage[key] = value;
  }
}

export type GeminiGenerateContentUsageSummary = {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  totalTokenCount?: number | null;
  cachedContentTokenCount?: number | null;
  thoughtsTokenCount?: number | null;
};

export type GeminiGenerateContentCandidateAggregate = {
  index: number;
  finishReason: string | null;
  parts: GeminiRecord[];
  groundingMetadata?: GeminiRecord;
  citationMetadata?: GeminiRecord;
};

export type GeminiGenerateContentAggregateState = {
  responseId: string | null;
  modelVersion: string | null;
  finishReason: string | null;
  parts: GeminiRecord[];
  citations: GeminiRecord[];
  groundingMetadata: GeminiRecord[];
  thoughtSignatures: string[];
  usage: GeminiGenerateContentUsageSummary;
  candidates: GeminiGenerateContentCandidateAggregate[];
};

export function createGeminiGenerateContentAggregateState(): GeminiGenerateContentAggregateState {
  return {
    responseId: null,
    modelVersion: null,
    finishReason: null,
    parts: [],
    citations: [],
    groundingMetadata: [],
    thoughtSignatures: [],
    usage: {},
    candidates: [],
  };
}

function ensureCandidateAggregate(
  state: GeminiGenerateContentAggregateState,
  rawIndex: unknown,
): GeminiGenerateContentCandidateAggregate {
  const normalizedIndex = typeof rawIndex === 'number' && Number.isFinite(rawIndex)
    ? Math.max(0, Math.trunc(rawIndex))
    : 0;
  let existing = state.candidates.find((candidate) => candidate.index === normalizedIndex);
  if (!existing) {
    existing = {
      index: normalizedIndex,
      finishReason: null,
      parts: [],
    };
    state.candidates.push(existing);
    state.candidates.sort((left, right) => left.index - right.index);
  }
  return existing;
}

export function applyGeminiGenerateContentAggregate(
  state: GeminiGenerateContentAggregateState,
  payload: unknown,
): GeminiGenerateContentAggregateState {
  for (const part of collectPartsFromPayload(payload)) {
    appendPart(state.parts, part);
    if (typeof part.thoughtSignature === 'string' && part.thoughtSignature.trim()) {
      if (!state.thoughtSignatures.includes(part.thoughtSignature)) {
        state.thoughtSignatures.push(part.thoughtSignature);
      }
    }
  }

  const payloads = Array.isArray(payload) ? payload : [payload];
  for (const item of payloads) {
    if (!isRecord(item)) continue;

    if (typeof item.responseId === 'string' && item.responseId.trim()) {
      state.responseId = item.responseId.trim();
    }
    if (typeof item.modelVersion === 'string' && item.modelVersion.trim()) {
      state.modelVersion = item.modelVersion.trim();
    }

    const candidates = Array.isArray(item.candidates) ? item.candidates : [];
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      const candidateAggregate = ensureCandidateAggregate(state, candidate.index);
      if (candidate.groundingMetadata !== undefined) {
        pushUniqueJson(state.groundingMetadata, candidate.groundingMetadata);
        if (isRecord(candidate.groundingMetadata)) {
          candidateAggregate.groundingMetadata = candidateAggregate.groundingMetadata
            ? mergeJsonRecords(candidateAggregate.groundingMetadata, candidate.groundingMetadata)
            : cloneJsonValue(candidate.groundingMetadata);
        }
      }
      if (candidate.citationMetadata !== undefined) {
        pushUniqueJson(state.citations, candidate.citationMetadata);
        if (isRecord(candidate.citationMetadata)) {
          candidateAggregate.citationMetadata = candidateAggregate.citationMetadata
            ? mergeJsonRecords(candidateAggregate.citationMetadata, candidate.citationMetadata)
            : cloneJsonValue(candidate.citationMetadata);
        }
      }
      if (typeof candidate.finishReason === 'string' && candidate.finishReason.trim()) {
        state.finishReason = candidate.finishReason.trim();
        candidateAggregate.finishReason = candidate.finishReason.trim();
      }

      const content = isRecord(candidate.content) ? candidate.content : null;
      if (content && Array.isArray(content.parts)) {
        for (const part of content.parts) {
          if (!isRecord(part)) continue;
          appendPart(candidateAggregate.parts, part);
        }
      }
    }

    const usageMetadata = isRecord(item.usageMetadata) ? item.usageMetadata : null;
    if (usageMetadata) {
      updateIfDefined(state.usage, 'promptTokenCount', usageMetadata.promptTokenCount);
      updateIfDefined(state.usage, 'candidatesTokenCount', usageMetadata.candidatesTokenCount);
      updateIfDefined(state.usage, 'totalTokenCount', usageMetadata.totalTokenCount);
      updateIfDefined(state.usage, 'cachedContentTokenCount', usageMetadata.cachedContentTokenCount);
      updateIfDefined(state.usage, 'thoughtsTokenCount', usageMetadata.thoughtsTokenCount);
    }
  }

  return state;
}
