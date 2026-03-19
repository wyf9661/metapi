import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import { mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function parseResponsesSsePayload(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getResponsesFailureMessage(payload: Record<string, unknown>): string {
  if (isRecord(payload.error) && typeof payload.error.message === 'string' && payload.error.message.trim()) {
    return payload.error.message.trim();
  }
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }
  return 'upstream stream failed';
}

function hasMeaningfulMessageContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!isRecord(part)) return false;
    const partType = typeof part.type === 'string' ? part.type.trim().toLowerCase() : '';
    if (partType === 'output_text' || partType === 'text') {
      return typeof part.text === 'string' && part.text.length > 0;
    }
    return true;
  });
}

function hasMeaningfulResponsesOutput(output: unknown): boolean {
  if (!Array.isArray(output)) return false;
  return output.some((item) => {
    if (!isRecord(item)) return false;
    const itemType = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
    if (itemType === 'message') {
      return hasMeaningfulMessageContent(item.content);
    }
    if (itemType === 'reasoning') {
      return (
        (Array.isArray(item.summary) && item.summary.length > 0)
        || (typeof item.encrypted_content === 'string' && item.encrypted_content.trim().length > 0)
      );
    }
    return itemType.length > 0;
  });
}

function hasCompleteFinalResponsesPayload(payload: Record<string, unknown>): boolean {
  return (
    payload.object === 'response.compaction'
    || Array.isArray(payload.output)
    || Object.prototype.hasOwnProperty.call(payload, 'output_text')
  );
}

function hasMeaningfulFinalResponsesPayload(payload: Record<string, unknown>): boolean {
  if (payload.object === 'response.compaction') {
    return Array.isArray(payload.output) && payload.output.length > 0;
  }
  if (typeof payload.output_text === 'string' && payload.output_text.length > 0) {
    return true;
  }
  return hasMeaningfulResponsesOutput(payload.output);
}

function rememberStreamResponseEnvelope(
  streamContext: ReturnType<typeof openAiResponsesTransformer.createStreamContext>,
  payload: Record<string, unknown>,
): void {
  const responsePayload = isRecord(payload.response) ? payload.response : payload;
  if (typeof responsePayload.id === 'string' && responsePayload.id.trim().length > 0) {
    streamContext.id = responsePayload.id;
  }
  if (typeof responsePayload.model === 'string' && responsePayload.model.trim().length > 0) {
    streamContext.model = responsePayload.model;
  }
  const createdAt = (
    typeof responsePayload.created_at === 'number' && Number.isFinite(responsePayload.created_at)
      ? responsePayload.created_at
      : (typeof responsePayload.created === 'number' && Number.isFinite(responsePayload.created)
        ? responsePayload.created
        : null)
  );
  if (createdAt !== null) {
    streamContext.created = createdAt;
  }
}

function materializeCompletedPayloadFromAggregate(
  aggregateState: ReturnType<typeof openAiResponsesTransformer.aggregator.createState>,
  streamContext: ReturnType<typeof openAiResponsesTransformer.createStreamContext>,
  usage: ReturnType<typeof parseProxyUsage>,
): Record<string, unknown> | null {
  const lines = openAiResponsesTransformer.aggregator.complete(
    aggregateState,
    streamContext,
    usage,
  );
  const { events } = openAiResponsesTransformer.pullSseEvents(lines.join(''));
  for (const event of events) {
    if (event.data === '[DONE]') continue;
    const payload = parseResponsesSsePayload(event.data);
    if (!payload) continue;
    if (event.event === 'response.completed' && isRecord(payload.response)) {
      return payload.response;
    }
    if (payload.type === 'response.completed' && hasCompleteFinalResponsesPayload(payload)) {
      return payload;
    }
  }
  return null;
}

export function looksLikeResponsesSseText(rawText: string): boolean {
  const { events, rest } = openAiResponsesTransformer.pullSseEvents(rawText);
  if (events.length === 0 || rest.trim().length > 0) return false;
  return events.some((event) => {
    if (event.data === '[DONE]') return true;
    if (event.event === 'error' || event.event.startsWith('response.')) return true;
    const payload = parseResponsesSsePayload(event.data);
    const payloadType = typeof payload?.type === 'string' ? payload.type : '';
    return payloadType === 'error' || payloadType.startsWith('response.');
  });
}

export function createSingleChunkStreamReader(rawText: string): {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
} {
  const chunk = Buffer.from(rawText, 'utf8');
  let done = false;
  return {
    async read() {
      if (done) return { done: true };
      done = true;
      return { done: false, value: chunk };
    },
    async cancel() {
      done = true;
      return undefined;
    },
    releaseLock() {},
  };
}

export function collectResponsesFinalPayloadFromSseText(
  rawText: string,
  modelName: string,
): { payload: Record<string, unknown>; rawText: string } {
  const { events } = openAiResponsesTransformer.pullSseEvents(rawText);
  const streamContext = openAiResponsesTransformer.createStreamContext(modelName);
  const aggregateState = openAiResponsesTransformer.aggregator.createState(modelName);
  let usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    promptTokensIncludeCache: null as boolean | null,
  };
  let completedPayload: Record<string, unknown> | null = null;

  const captureCompletedPayloadFromEvent = (
    eventType: string,
    payload: Record<string, unknown>,
  ) => {
    if (completedPayload) return;
    if (eventType === 'response.failed' || eventType === 'response.incomplete' || eventType === 'error') {
      throw new Error(getResponsesFailureMessage(payload));
    }
    if (eventType !== 'response.completed') {
      return;
    }
    if (isRecord(payload.response) && hasCompleteFinalResponsesPayload(payload.response)) {
      completedPayload = payload.response;
      return;
    }
    if (hasCompleteFinalResponsesPayload(payload)) {
      completedPayload = payload;
    }
  };

  const captureCompletedPayloadFromLines = (lines: string[]) => {
    if (completedPayload) return;
    const parsed = openAiResponsesTransformer.pullSseEvents(lines.join(''));
    for (const event of parsed.events) {
      if (event.data === '[DONE]') continue;
      const payload = parseResponsesSsePayload(event.data);
      if (!payload) continue;
      const payloadType = typeof payload.type === 'string' ? payload.type : '';
      captureCompletedPayloadFromEvent(payloadType || event.event, payload);
      if (completedPayload) {
        return;
      }
    }
  };

  for (const event of events) {
    if (event.data === '[DONE]') continue;
    const payload = parseResponsesSsePayload(event.data);
    if (!payload) continue;

    const payloadType = typeof payload.type === 'string' ? payload.type : '';
    const eventType = payloadType || event.event;
    rememberStreamResponseEnvelope(streamContext, payload);
    usage = mergeProxyUsage(usage, parseProxyUsage(payload));
    captureCompletedPayloadFromEvent(eventType, payload);
    if (completedPayload) {
      continue;
    }
    const normalizedEvent = openAiResponsesTransformer.transformStreamEvent(
      payload,
      streamContext,
      modelName,
    );
    captureCompletedPayloadFromLines(openAiResponsesTransformer.aggregator.serialize({
      state: aggregateState,
      streamContext,
      event: normalizedEvent,
      usage,
    }));
  }

  if (
    completedPayload
    && !hasMeaningfulFinalResponsesPayload(completedPayload)
    && hasMeaningfulResponsesOutput(aggregateState.outputItems)
  ) {
    completedPayload = materializeCompletedPayloadFromAggregate(aggregateState, streamContext, usage);
  }

  if (!completedPayload) {
    const materialized = materializeCompletedPayloadFromAggregate(aggregateState, streamContext, usage);
    if (materialized) {
      completedPayload = materialized;
    }
  }

  if (completedPayload) {
    return {
      payload: completedPayload,
      rawText,
    };
  }

  throw new Error('stream disconnected before response.completed');
}

export async function collectResponsesFinalPayloadFromSse(
  upstream: { text(): Promise<string> },
  modelName: string,
): Promise<{ payload: Record<string, unknown>; rawText: string }> {
  return collectResponsesFinalPayloadFromSseText(await upstream.text(), modelName);
}
