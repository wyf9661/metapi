import {
  createStreamTransformContext,
  normalizeUpstreamStreamEvent,
  pullSseEventsWithDone,
  type NormalizedStreamEvent,
  type StreamTransformContext,
} from '../../shared/normalized.js';
import {
  completeResponsesStream,
  createOpenAiResponsesAggregateState,
  failResponsesStream,
  serializeConvertedResponsesEvents,
  type OpenAiResponsesAggregateState,
} from './aggregator.js';
import {
  buildNormalizedFinalToOpenAiResponsesPayload,
  normalizeOpenAiResponsesFinalToNormalized,
  type ResponsesUsageSummary,
} from './responseBridge.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
    ) as T;
  }
  return value;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasMeaningfulContentPart(part: unknown): boolean {
  if (!isRecord(part)) return false;
  const partType = asTrimmedString(part.type).toLowerCase();
  if (partType === 'output_text' || partType === 'text') {
    return hasNonEmptyString(part.text);
  }
  return partType.length > 0;
}

export function hasMeaningfulResponsesOutputItem(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const itemType = asTrimmedString(item.type).toLowerCase();
  if (itemType === 'message') {
    return Array.isArray(item.content) && item.content.some((part) => hasMeaningfulContentPart(part));
  }
  if (itemType === 'reasoning') {
    return (
      (Array.isArray(item.summary) && item.summary.some((part) => hasMeaningfulContentPart(part)))
      || hasNonEmptyString(item.encrypted_content)
    );
  }
  return itemType.length > 0;
}

export function hasMeaningfulResponsesPayloadOutput(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (hasNonEmptyString(payload.output_text)) return true;
  return Array.isArray(payload.output) && payload.output.some((item) => hasMeaningfulResponsesOutputItem(item));
}

export function preserveMeaningfulResponsesTerminalPayload(
  lines: string[],
  eventType: 'response.completed' | 'response.incomplete',
  payload: Record<string, unknown>,
): string[] {
  const responsePayload = isRecord(payload.response) ? payload.response : null;
  if (!responsePayload || !hasMeaningfulResponsesPayloadOutput(responsePayload)) {
    return lines;
  }

  const parsed = openAiResponsesStream.pullSseEvents(lines.join(''));
  let replaced = false;
  const nextLines: string[] = [];

  for (const event of parsed.events) {
    if (event.data === '[DONE]') {
      nextLines.push('data: [DONE]\n\n');
      continue;
    }

    let parsedPayload: unknown = null;
    try {
      parsedPayload = JSON.parse(event.data);
    } catch {
      nextLines.push(`${event.event ? `event: ${event.event}\n` : ''}data: ${event.data}\n\n`);
      continue;
    }

    if (
      isRecord(parsedPayload)
      && asTrimmedString(parsedPayload.type) === eventType
      && isRecord(parsedPayload.response)
      && !hasMeaningfulResponsesPayloadOutput(parsedPayload.response)
    ) {
      replaced = true;
      nextLines.push(
        `event: ${event.event || eventType}\ndata: ${JSON.stringify({
          ...parsedPayload,
          response: {
            ...parsedPayload.response,
            ...responsePayload,
          },
        })}\n\n`,
      );
      continue;
    }

    nextLines.push(`${event.event ? `event: ${event.event}\n` : ''}data: ${event.data}\n\n`);
  }

  return replaced ? nextLines : lines;
}

export function serializeResponsesUpstreamFinalAsStream(input: {
  payload: unknown;
  modelName: string;
  fallbackText: string;
  usage: ResponsesUsageSummary;
}): {
  normalizedFinal: ReturnType<typeof normalizeOpenAiResponsesFinalToNormalized>;
  streamPayload: Record<string, unknown>;
  createdPayload: Record<string, unknown>;
  isIncompletePayload: boolean;
  lines: string[];
} {
  const { payload, modelName, fallbackText, usage } = input;
  const normalizedFinal = normalizeOpenAiResponsesFinalToNormalized(payload, modelName, fallbackText);
  const streamPayload = buildNormalizedFinalToOpenAiResponsesPayload({
    upstreamPayload: payload,
    normalized: normalizedFinal,
    usage,
    serializationMode: 'response',
  });
  const payloadType = (isRecord(payload) && typeof payload.type === 'string')
    ? payload.type
    : '';
  const payloadStatus = isRecord(payload) && typeof payload.status === 'string'
    ? payload.status
    : '';
  const isFailedPayload = payloadType === 'response.failed' || payloadStatus === 'failed';
  const isIncompletePayload = payloadType === 'response.incomplete' || payloadStatus === 'incomplete';
  const terminalStatus = isFailedPayload ? 'failed' : (isIncompletePayload ? 'incomplete' : 'completed');
  const upstreamTerminalResponse = isRecord(payload) && isRecord(payload.response)
    ? cloneJson(payload.response)
    : null;
  const terminalResponsePayload = upstreamTerminalResponse
    ? {
      ...streamPayload,
      ...upstreamTerminalResponse,
      ...(Array.isArray(upstreamTerminalResponse.output) ? { output: cloneJson(upstreamTerminalResponse.output) } : {}),
      ...(typeof upstreamTerminalResponse.output_text === 'string'
        ? { output_text: upstreamTerminalResponse.output_text }
        : {}),
      status: terminalStatus,
    }
    : {
      ...streamPayload,
      status: terminalStatus,
    };
  const createdPayload = {
    ...terminalResponsePayload,
    status: 'in_progress',
    output: [],
    output_text: '',
  };

  const terminalEventType = isFailedPayload
    ? 'response.failed'
    : (isIncompletePayload ? 'response.incomplete' : 'response.completed');
  const fallbackState = createOpenAiResponsesAggregateState(normalizedFinal.model || modelName);
  const fallbackContext = createStreamTransformContext(normalizedFinal.model || modelName);
  fallbackContext.id = normalizedFinal.id;
  fallbackContext.model = normalizedFinal.model;
  fallbackContext.created = normalizedFinal.created;

  const lines = [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: createdPayload })}\n\n`,
  ];

  const outputItems = Array.isArray(terminalResponsePayload.output) ? terminalResponsePayload.output : [];
  for (let outputIndex = 0; outputIndex < outputItems.length; outputIndex += 1) {
    const item = outputItems[outputIndex];
    if (!isRecord(item)) continue;
    const eventItem = cloneJson(item);
    const itemStatus = asTrimmedString(eventItem.status).toLowerCase();
    if ((!itemStatus || itemStatus === 'in_progress') && terminalStatus !== 'completed') {
      eventItem.status = terminalStatus;
    }
    lines.push(...serializeConvertedResponsesEvents({
      state: fallbackState,
      streamContext: fallbackContext,
      usage,
      event: {
        responsesEventType: 'response.output_item.done',
        responsesPayload: {
          type: 'response.output_item.done',
          output_index: outputIndex,
          item: eventItem,
        },
      },
    }));
  }

  lines.push(...serializeConvertedResponsesEvents({
    state: fallbackState,
    streamContext: fallbackContext,
    usage,
    event: {
        responsesEventType: terminalEventType,
        responsesPayload: {
          type: terminalEventType,
          response: terminalResponsePayload,
        ...(terminalEventType === 'response.failed' && isRecord(payload) && payload.error !== undefined
          ? { error: cloneJson(payload.error) }
          : {}),
      },
    },
  }));
  lines.push('data: [DONE]\n\n');

  return {
    normalizedFinal,
    streamPayload,
    createdPayload,
    isIncompletePayload,
    lines,
  };
}

export type OpenAiResponsesStreamEvent = NormalizedStreamEvent & {
  responsesEventType?: string;
  responsesPayload?: Record<string, unknown>;
  usagePayload?: Record<string, unknown>;
};

export const openAiResponsesStream = {
  eventNames: [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.output_item.done',
    'response.content_part.added',
    'response.content_part.done',
    'response.output_text.delta',
    'response.output_text.done',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.custom_tool_call_input.delta',
    'response.custom_tool_call_input.done',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_part.done',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.image_generation_call.generating',
    'response.image_generation_call.in_progress',
    'response.image_generation_call.partial_image',
    'response.image_generation_call.completed',
    'response.completed',
    'response.incomplete',
    'response.failed',
  ] as const,
  createContext(modelName: string): StreamTransformContext {
    return createStreamTransformContext(modelName);
  },
  normalizeEvent(payload: unknown, context: StreamTransformContext, modelName: string): OpenAiResponsesStreamEvent {
    const normalized = normalizeUpstreamStreamEvent(payload, context, modelName) as OpenAiResponsesStreamEvent;
    if (isRecord(payload) && typeof payload.type === 'string' && payload.type.startsWith('response.')) {
      normalized.responsesEventType = payload.type;
      normalized.responsesPayload = payload;
    }
    if (isRecord(payload) && isRecord(payload.usage)) {
      normalized.usagePayload = payload.usage;
    }
    return normalized;
  },
  pullSseEvents(buffer: string) {
    return pullSseEventsWithDone(buffer);
  },
};

export type ResponsesStreamState = OpenAiResponsesAggregateState;

export function createResponsesStreamState(modelName: string): ResponsesStreamState {
  return createOpenAiResponsesAggregateState(modelName);
}

export {
  completeResponsesStream,
  failResponsesStream,
  serializeConvertedResponsesEvents,
};
