import type {
  OpenAiChatChoice,
  OpenAiChatChoiceDelta,
  OpenAiChatNormalizedFinalResponse,
  OpenAiChatNormalizedStreamEvent,
  OpenAiChatUsageDetails,
} from './model.js';
import { mergeChatUsageDetails } from './helpers.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function pushUniqueAnnotation(
  annotations: Array<Record<string, unknown>>,
  seenUrls: Set<string>,
  candidate: unknown,
) {
  if (!isRecord(candidate)) return;
  const citation = isRecord(candidate.url_citation) ? candidate.url_citation : null;
  const url = citation && typeof citation.url === 'string' ? citation.url.trim() : '';
  if (!url || seenUrls.has(url)) return;
  seenUrls.add(url);
  annotations.push(candidate);
}

type ChoiceAggregate = {
  index: number;
  role?: 'assistant';
  content: string[];
  reasoning: string[];
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  annotations: Array<Record<string, unknown>>;
  annotationUrls: Set<string>;
  citations: Set<string>;
};

export type OpenAiChatAggregateState = {
  choices: Map<number, ChoiceAggregate>;
  citations: Set<string>;
  usageDetails?: OpenAiChatUsageDetails;
};

function createChoiceAggregate(index: number): ChoiceAggregate {
  return {
    index,
    role: undefined,
    content: [],
    reasoning: [],
    toolCalls: [],
    finishReason: null,
    annotations: [],
    annotationUrls: new Set<string>(),
    citations: new Set<string>(),
  };
}

function getChoiceAggregate(state: OpenAiChatAggregateState, index: number): ChoiceAggregate {
  const existing = state.choices.get(index);
  if (existing) return existing;
  const created = createChoiceAggregate(index);
  state.choices.set(index, created);
  return created;
}

function applyChoiceDelta(choice: ChoiceAggregate, event: OpenAiChatChoiceDelta) {
  if (event.role) choice.role = event.role;
  if (event.contentDelta) choice.content.push(event.contentDelta);
  if (event.reasoningDelta) choice.reasoning.push(event.reasoningDelta);
  if (event.finishReason !== undefined) choice.finishReason = event.finishReason ?? null;
  if (Array.isArray(event.toolCallDeltas)) {
    for (const delta of event.toolCallDeltas) {
      if (!delta.id && !delta.name && !delta.argumentsDelta) continue;
      const index = Number.isFinite(delta.index) ? Math.max(0, Math.trunc(delta.index)) : choice.toolCalls.length;
      while (choice.toolCalls.length <= index) {
        choice.toolCalls.push({ id: '', name: '', arguments: '' });
      }
      const existing = choice.toolCalls[index];
      if (delta.id) existing.id = delta.id;
      if (delta.name) existing.name = delta.name;
      if (delta.argumentsDelta) existing.arguments += delta.argumentsDelta;
    }
  }
  if (Array.isArray(event.annotations)) {
    for (const annotation of event.annotations) {
      pushUniqueAnnotation(choice.annotations, choice.annotationUrls, annotation);
    }
  }
  if (Array.isArray(event.citations)) {
    for (const citation of event.citations) {
      if (typeof citation === 'string' && citation.trim()) {
        choice.citations.add(citation.trim());
      }
    }
  }
}

export function createOpenAiChatAggregateState(): OpenAiChatAggregateState {
  return {
    choices: new Map<number, ChoiceAggregate>(),
    citations: new Set<string>(),
    usageDetails: undefined,
  };
}

export function applyOpenAiChatStreamEvent(
  state: OpenAiChatAggregateState,
  event: OpenAiChatNormalizedStreamEvent,
): OpenAiChatAggregateState {
  const choiceEvents = Array.isArray(event.choiceEvents) && event.choiceEvents.length > 0
    ? event.choiceEvents
    : [{
      index: Number.isFinite(event.choiceIndex) ? Math.max(0, Math.trunc(event.choiceIndex!)) : 0,
      role: event.role,
      contentDelta: event.contentDelta,
      reasoningDelta: event.reasoningDelta,
      toolCallDeltas: event.toolCallDeltas,
      finishReason: event.finishReason,
      annotations: event.annotations,
      citations: event.citations,
    } satisfies OpenAiChatChoiceDelta];

  for (const choiceEvent of choiceEvents) {
    const choice = getChoiceAggregate(state, choiceEvent.index);
    applyChoiceDelta(choice, choiceEvent);
  }

  if (Array.isArray(event.citations)) {
    for (const citation of event.citations) {
      if (typeof citation === 'string' && citation.trim()) state.citations.add(citation.trim());
    }
  }
  for (const choice of state.choices.values()) {
    for (const citation of choice.citations) state.citations.add(citation);
  }

  state.usageDetails = mergeChatUsageDetails(state.usageDetails, event.usageDetails);
  return state;
}

export function finalizeOpenAiChatAggregate(
  state: OpenAiChatAggregateState,
  normalized: OpenAiChatNormalizedFinalResponse,
): OpenAiChatNormalizedFinalResponse {
  if (state.choices.size === 0 && state.citations.size === 0 && !state.usageDetails) {
    return normalized;
  }

  const finalizedChoices: OpenAiChatChoice[] = Array.from(state.choices.values())
    .sort((left, right) => left.index - right.index)
    .map((choice) => {
      const toolCalls = choice.toolCalls.filter((item) => item.id || item.name || item.arguments);
      return {
        index: choice.index,
        ...(choice.role ? { role: choice.role } : {}),
        content: choice.content.join(''),
        reasoningContent: choice.reasoning.join(''),
        toolCalls,
        finishReason: choice.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        ...(choice.annotations.length > 0 ? { annotations: choice.annotations } : {}),
        ...(choice.citations.size > 0 ? { citations: Array.from(choice.citations).sort() } : {}),
      };
    });

  const primaryChoice = finalizedChoices[0];
  const normalizedChoices = Array.isArray(normalized.choices) ? normalized.choices : [];
  const mergedChoices = finalizedChoices.length > 0 ? finalizedChoices : normalizedChoices;

  return {
    ...normalized,
    content: primaryChoice?.content || normalized.content,
    reasoningContent: primaryChoice?.reasoningContent || normalized.reasoningContent,
    finishReason: primaryChoice?.finishReason || normalized.finishReason,
    toolCalls: primaryChoice?.toolCalls?.length ? primaryChoice.toolCalls : normalized.toolCalls,
    annotations: primaryChoice?.annotations?.length ? primaryChoice.annotations : normalized.annotations,
    citations: state.citations.size > 0 ? Array.from(state.citations).sort() : normalized.citations,
    usageDetails: mergeChatUsageDetails(normalized.usageDetails, state.usageDetails),
    ...(mergedChoices.length > 0 ? { choices: mergedChoices } : {}),
  };
}
