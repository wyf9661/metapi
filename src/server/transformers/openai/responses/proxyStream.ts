import { createProxyStreamLifecycle } from '../../shared/protocolLifecycle.js';
import { resolveProxyStreamIdleTimeoutMs } from '../../../config.js';
import { type ParsedSseEvent } from '../../shared/normalized.js';
import { completeResponsesStream, createOpenAiResponsesAggregateState, failResponsesStream, serializeConvertedResponsesEvents } from './aggregator.js';
import {
  hasMeaningfulResponsesOutputItem,
  hasMeaningfulResponsesPayloadOutput,
  hasReasoningResponsesOutputItem,
  hasReasoningResponsesPayloadOutput,
  hasVisibleResponsesOutputItem,
  hasVisibleResponsesPayloadOutput,
  openAiResponsesStream,
  preserveMeaningfulResponsesTerminalPayload,
  serializeResponsesUpstreamFinalAsStream,
} from './streamBridge.js';
import { config } from '../../../config.js';
import { hasMalformedToolCallArguments } from '../../shared/toolCallAssembler.js';


type StreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

type ResponseSink = {
  end(): void;
};

type ResponsesProxyStreamResult = {
  status: 'completed' | 'failed';
  errorMessage: string | null;
};

type ResponsesProxyStreamSessionInput = {
  modelName: string;
  successfulUpstreamPath: string;
  strictTerminalEvents?: boolean;
  getUsage: () => {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    promptTokensIncludeCache: boolean | null;
  };
  onParsedPayload?: (payload: unknown) => void;
  writeLines: (lines: string[]) => void;
  writeRaw: (chunk: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function hasVisibleAggregateOutput(state: ReturnType<typeof createOpenAiResponsesAggregateState>): boolean {
  return state.outputItems.some((item) => hasVisibleResponsesOutputItem(item));
}

function hasReasoningAggregateOutput(state: ReturnType<typeof createOpenAiResponsesAggregateState>): boolean {
  return state.outputItems.some((item) => hasReasoningResponsesOutputItem(item));
}

// Empty-content gate. Reasoning items are not deliverable output: a
// completion that only produced reasoning never delivered a final answer, so
// it fails here (with a distinct message) just like a fully empty completion,
// and the attempt can still fail over. A visible function_call whose arguments
// never parse is equally undeliverable (a damaged relay split one call across
// slots), so it fails too. Returns the failure message, or null when the
// payload is fine.
function shouldFailEmptyResponsesCompletion(input: {
  payload: unknown;
  state: ReturnType<typeof createOpenAiResponsesAggregateState>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}): string | null {
  if (!config.proxyEmptyContentFailEnabled) return null;
  const responsePayload = isRecord(input.payload) && isRecord(input.payload.response)
    ? input.payload.response
    : null;
  const aggregateMalformed = hasMalformedToolCallArguments(
    input.state.outputItems
      .filter((item) => isRecord(item) && String(item.type || '').toLowerCase() === 'function_call')
      .map((item) => (item as Record<string, unknown>).arguments),
  );
  const payloadMalformed = !!responsePayload && Array.isArray(responsePayload.output)
    && hasMalformedToolCallArguments(
      responsePayload.output
        .filter((item) => isRecord(item) && String(item.type || '').toLowerCase() === 'function_call')
        .map((item) => (item as Record<string, unknown>).arguments),
    );
  if (hasVisibleAggregateOutput(input.state) || (responsePayload && hasVisibleResponsesPayloadOutput(responsePayload))) {
    return aggregateMalformed || payloadMalformed
      ? 'Upstream returned malformed tool call arguments'
      : null;
  }
  const reasoningOnly = hasReasoningAggregateOutput(input.state)
    || (responsePayload ? hasReasoningResponsesPayloadOutput(responsePayload) : false);
  if (reasoningOnly) return 'Upstream returned empty content (reasoning only)';
  return input.usage.completionTokens <= 0 ? 'Upstream returned empty content' : null;
}

function getResponsesStreamFailureMessage(payload: unknown, fallback = 'upstream stream failed'): string {
  if (isRecord(payload)) {
    if (isRecord(payload.error) && typeof payload.error.message === 'string' && payload.error.message.trim()) {
      return payload.error.message.trim();
    }
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
    if (isRecord(payload.response) && isRecord(payload.response.error) && typeof payload.response.error.message === 'string' && payload.response.error.message.trim()) {
      return payload.response.error.message.trim();
    }
  }
  return fallback;
}

export function createResponsesProxyStreamSession(input: ResponsesProxyStreamSessionInput) {
  const streamContext = openAiResponsesStream.createContext(input.modelName);
  const responsesState = createOpenAiResponsesAggregateState(input.modelName);
  const requiresExplicitTerminalEvent = input.strictTerminalEvents
    || input.successfulUpstreamPath.endsWith('/responses')
    || input.successfulUpstreamPath.endsWith('/responses/compact');
  let finalized = false;
  let terminalEventSeen = false;
  let terminalResult: ResponsesProxyStreamResult = {
    status: 'completed',
    errorMessage: null,
  };
  let forwardedOutput = false;
  const pendingWrites: string[] = [];
  const emitLines = (lines: string[], force = false) => {
    if (lines.length === 0) return;
    if (!forwardedOutput && !force && !responsesState.outputItems.some(hasMeaningfulResponsesOutputItem)) {
      pendingWrites.push(...lines);
      return;
    }
    forwardedOutput = true;
    if (pendingWrites.length > 0) {
      input.writeLines(pendingWrites);
      pendingWrites.length = 0;
    }
    input.writeLines(lines);
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    terminalResult = {
      status: 'completed',
      errorMessage: null,
    };
    emitLines(completeResponsesStream(responsesState, streamContext, input.getUsage()), true);
  };

  const fail = (payload: unknown, fallbackMessage?: string, options?: { writeFrame?: boolean }) => {
    if (finalized) return;
    finalized = true;
    terminalResult = {
      status: 'failed',
      errorMessage: getResponsesStreamFailureMessage(payload, fallbackMessage),
    };
    // Two different verdicts arrive here:
    // - an upstream terminal failure (`response.failed`): the client must see
    //   it, including any partial output it carries;
    // - a local gate verdict (empty content): nothing was delivered, and the
    //   caller may still fail over to another channel — writing a frame now
    //   would commit the response and kill that failover.
    // `writeFrame` defaults to true (upstream terminal); the local gate passes
    // false.
    // An upstream terminal failure that still carries output must reach the
    // client even when nothing was forwarded before it: that output is the
    // turn's only content and dropping it leaves the stream with nothing. A
    // local gate verdict (empty content) carries no output and must not commit
    // the response — the caller may still fail over to another channel.
    const responsePayload = isRecord(payload) && isRecord(payload.response) ? payload.response : null;
    const carriesOutput = hasMeaningfulResponsesPayloadOutput(payload)
      || (responsePayload ? hasMeaningfulResponsesPayloadOutput(responsePayload) : false);
    const writeFrame = options?.writeFrame !== false && (forwardedOutput || carriesOutput);
    if (writeFrame) {
      // A pending buffer that carries output is flushed first so partial
      // content is not lost on the way out.
      if (pendingWrites.length > 0) {
        input.writeLines(pendingWrites);
        pendingWrites.length = 0;
      }
      input.writeLines(failResponsesStream(responsesState, streamContext, input.getUsage(), payload));
    }
    pendingWrites.length = 0;
  };

  const complete = () => {
    terminalResult = {
      status: 'completed',
      errorMessage: null,
    };
  };

  const closeOut = () => {
    if (finalized) return;
    if (terminalEventSeen) {
      finalize();
      return;
    }
    if (requiresExplicitTerminalEvent) {
      fail({
        type: 'response.failed',
        error: {
          message: 'stream closed before response.completed',
        },
      }, 'stream closed before response.completed');
      return;
    }
    finalize();
  };

  const handleEventBlock = (eventBlock: ParsedSseEvent): boolean => {
    if (eventBlock.data === '[DONE]') {
      closeOut();
      return true;
    }

    let parsedPayload: unknown = null;
    try {
      parsedPayload = JSON.parse(eventBlock.data);
    } catch {
      parsedPayload = null;
    }

    if (isRecord(parsedPayload)) {
      input.onParsedPayload?.(parsedPayload);
    }

    const payloadType = (isRecord(parsedPayload) && typeof parsedPayload.type === 'string')
      ? parsedPayload.type
      : '';
    const isFailureEvent = (
      eventBlock.event === 'error'
      || eventBlock.event === 'response.failed'
      || payloadType === 'error'
      || payloadType === 'response.failed'
    );
    if (isFailureEvent) {
      fail(parsedPayload);
      return true;
    }
    const isIncompleteEvent = eventBlock.event === 'response.incomplete' || payloadType === 'response.incomplete';

    if (isRecord(parsedPayload)) {
      const normalizedEvent = openAiResponsesStream.normalizeEvent(parsedPayload, streamContext, input.modelName);
      let convertedLines = serializeConvertedResponsesEvents({
        state: responsesState,
        streamContext,
        event: normalizedEvent,
        usage: input.getUsage(),
      });
      if (isIncompleteEvent) {
        convertedLines = preserveMeaningfulResponsesTerminalPayload(convertedLines, 'response.incomplete', parsedPayload);
      } else if (eventBlock.event === 'response.completed' || payloadType === 'response.completed') {
        convertedLines = preserveMeaningfulResponsesTerminalPayload(convertedLines, 'response.completed', parsedPayload);
      }
      if (eventBlock.event === 'response.completed' || payloadType === 'response.completed') {
        const emptyFailureMessage = shouldFailEmptyResponsesCompletion({
          payload: parsedPayload,
          state: responsesState,
          usage: input.getUsage(),
        });
        if (emptyFailureMessage) {
          fail({
            type: 'response.failed',
            error: {
              message: emptyFailureMessage,
            },
          }, emptyFailureMessage);
          return true;
        }
      }
      // A terminal event must reach the client even when nothing visible was
      // streamed before it: `response.failed` can carry partial output the
      // client needs (and `response.incomplete` is the truncation verdict).
      // Holding it back drops that output on the floor — the stream then ends
      // with nothing at all.
      const isTerminalEvent = isIncompleteEvent
        || eventBlock.event === 'response.failed'
        || payloadType === 'response.failed'
        || eventBlock.event === 'response.completed'
        || payloadType === 'response.completed';
      emitLines(convertedLines, isTerminalEvent || !config.proxyEmptyContentFailEnabled);
      if (eventBlock.event === 'response.completed' || payloadType === 'response.completed' || isIncompleteEvent) {
        terminalEventSeen = true;
        complete();
      }
      return false;
    }

    emitLines(serializeConvertedResponsesEvents({
      state: responsesState,
      streamContext,
      event: { contentDelta: eventBlock.data },
      usage: input.getUsage(),
    }));
    return false;
  };

  return {
    consumeUpstreamFinalPayload(payload: unknown, fallbackText: string, response?: ResponseSink): ResponsesProxyStreamResult {
      if (payload && typeof payload === 'object') {
        input.onParsedPayload?.(payload);
      }

      const payloadType = (isRecord(payload) && typeof payload.type === 'string')
        ? payload.type
        : '';
      if (payloadType === 'error' || payloadType === 'response.failed') {
        fail(payload);
        response?.end();
        return terminalResult;
      }

      const serializedFinal = serializeResponsesUpstreamFinalAsStream({
        payload,
        modelName: input.modelName,
        fallbackText,
        usage: input.getUsage(),
      });
      const { normalizedFinal, streamPayload, isIncompletePayload, lines } = serializedFinal;
      streamContext.id = normalizedFinal.id;
      streamContext.model = normalizedFinal.model;
      streamContext.created = normalizedFinal.created;
      const emptyFailureMessage = isIncompletePayload
        ? null
        : shouldFailEmptyResponsesCompletion({
          payload: { type: 'response.completed', response: streamPayload },
          state: responsesState,
          usage: input.getUsage(),
        });
      if (emptyFailureMessage) {
        fail({
          type: 'response.failed',
          error: {
            message: emptyFailureMessage,
          },
        }, emptyFailureMessage);
        response?.end();
        return terminalResult;
      }

      finalized = true;
      terminalResult = {
        status: 'completed',
        errorMessage: null,
      };
      input.writeLines(lines);
      response?.end();
      return terminalResult;
    },
    async run(reader: StreamReader | null | undefined, response: ResponseSink): Promise<ResponsesProxyStreamResult> {
      const lifecycle = createProxyStreamLifecycle<ParsedSseEvent>({
        reader,
        response,
        pullEvents: (buffer) => openAiResponsesStream.pullSseEvents(buffer),
        handleEvent: handleEventBlock,
        onEof: closeOut,
        idleTimeoutMs: resolveProxyStreamIdleTimeoutMs(),
        onFirstByteTimeout: (elapsedMs) => {
          // Nothing in the per-site first-byte estimator reaches this read loop, so the
          // configured ceiling is the only bound: surface it when it fires, otherwise an
          // upstream that opens a stream and goes quiet looks like a clean early EOF.
          console.warn(`[proxy-stream/responses] no first byte within ${elapsedMs}ms for model ${input.modelName ?? 'unknown'}`);
        },
      });
      await lifecycle.run();
      return terminalResult;
    },
  };
}
