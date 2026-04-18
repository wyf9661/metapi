import { createProxyStreamLifecycle } from '../../shared/protocolLifecycle.js';
import { type ParsedSseEvent } from '../../shared/normalized.js';
import { completeResponsesStream, createOpenAiResponsesAggregateState, failResponsesStream, serializeConvertedResponsesEvents } from './aggregator.js';
import {
  hasMeaningfulResponsesOutputItem,
  hasMeaningfulResponsesPayloadOutput,
  openAiResponsesStream,
  preserveMeaningfulResponsesTerminalPayload,
  serializeResponsesUpstreamFinalAsStream,
} from './streamBridge.js';
import { config } from '../../../config.js';

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

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasMeaningfulAggregateOutput(state: ReturnType<typeof createOpenAiResponsesAggregateState>): boolean {
  return state.outputItems.some((item) => hasMeaningfulResponsesOutputItem(item));
}

function shouldFailEmptyResponsesCompletion(input: {
  payload: unknown;
  state: ReturnType<typeof createOpenAiResponsesAggregateState>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}): boolean {
  if (!config.proxyEmptyContentFailEnabled) return false;
  const responsePayload = isRecord(input.payload) && isRecord(input.payload.response)
    ? input.payload.response
    : null;
  if (hasMeaningfulAggregateOutput(input.state)) return false;
  if (responsePayload && hasMeaningfulResponsesPayloadOutput(responsePayload)) return false;
  return input.usage.completionTokens <= 0;
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

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    terminalResult = {
      status: 'completed',
      errorMessage: null,
    };
    input.writeLines(completeResponsesStream(responsesState, streamContext, input.getUsage()));
  };

  const fail = (payload: unknown, fallbackMessage?: string) => {
    if (finalized) return;
    finalized = true;
    terminalResult = {
      status: 'failed',
      errorMessage: getResponsesStreamFailureMessage(payload, fallbackMessage),
    };
    input.writeLines(failResponsesStream(responsesState, streamContext, input.getUsage(), payload));
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
      if (
        (eventBlock.event === 'response.completed' || payloadType === 'response.completed')
        && shouldFailEmptyResponsesCompletion({
          payload: parsedPayload,
          state: responsesState,
          usage: input.getUsage(),
        })
      ) {
        fail({
          type: 'response.failed',
          error: {
            message: 'Upstream returned empty content',
          },
        }, 'Upstream returned empty content');
        return true;
      }
      input.writeLines(convertedLines);
      if (eventBlock.event === 'response.completed' || payloadType === 'response.completed' || isIncompleteEvent) {
        terminalEventSeen = true;
        complete();
      }
      return false;
    }

    input.writeLines(serializeConvertedResponsesEvents({
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
      if (!isIncompletePayload && shouldFailEmptyResponsesCompletion({
        payload: { type: 'response.completed', response: streamPayload },
        state: responsesState,
        usage: input.getUsage(),
      })) {
        fail({
          type: 'response.failed',
          error: {
            message: 'Upstream returned empty content',
          },
        }, 'Upstream returned empty content');
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
      });
      await lifecycle.run();
      return terminalResult;
    },
  };
}
