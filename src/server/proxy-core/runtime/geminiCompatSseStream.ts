import {
  createStreamTransformContext,
  normalizeUpstreamStreamEvent,
} from '../../transformers/shared/chatFormatsCore.js';
import { mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { toGeminiFinishReason } from '../../transformers/shared/finishReason.js';

type ParsedUsage = ReturnType<typeof parseProxyUsage>;

export type GeminiCompatSseRelayResult = {
  usage: ParsedUsage;
  finishReason: string | null;
  rawStreamText: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Split an accumulating SSE buffer into complete frames.
 * OpenAI-compatible relays terminate events with a blank line; CRLF endings are tolerated.
 */
function drainSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  while (true) {
    const match = /\r?\n\r?\n/.exec(rest);
    if (!match || match.index === undefined) break;
    frames.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return { frames, rest };
}

function payloadDataFromFrame(frame: string): string | null {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice(5).trimStart());
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

function buildUsageMetadata(usage: ParsedUsage): Record<string, number> | undefined {
  const metadata: Record<string, number> = {};
  if (usage.promptTokens > 0) metadata.promptTokenCount = usage.promptTokens;
  if (usage.completionTokens > 0) metadata.candidatesTokenCount = usage.completionTokens;
  if (usage.totalTokens > 0) metadata.totalTokenCount = usage.totalTokens;
  if (usage.cacheReadTokens > 0) metadata.cachedContentTokenCount = usage.cacheReadTokens;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function mapFinishReason(finishReason: string | null): string {
  if (!finishReason || !finishReason.trim()) return 'STOP';
  return toGeminiFinishReason(finishReason);
}

/**
 * Relay an OpenAI-compatible chat SSE stream as a Gemini `streamGenerateContent?alt=sse` stream.
 *
 * Before this existed the Gemini compatibility path buffered the whole upstream body and fed it
 * to the *final* response serializer: an SSE body failed `JSON.parse`, so the raw `data: {...}`
 * text was emitted as one Gemini chunk's content and `parseProxyUsage` saw a string, not an
 * object — the request logged 0/0 tokens and the client received protocol garbage.
 */
export async function relayOpenAiChatSseToGeminiSse(input: {
  reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<unknown>;
    releaseLock(): void;
  };
  modelName: string;
  responseId: string;
  write: (line: string) => void;
  wrapResponsePayload?: boolean;
}): Promise<GeminiCompatSseRelayResult> {
  const decoder = new TextDecoder();
  const streamContext = createStreamTransformContext(input.modelName);
  let usage: ParsedUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    promptTokensIncludeCache: null,
  };
  let finishReason: string | null = null;
  let rawStreamText = '';
  let rest = '';
  let sawDone = false;
  // OpenAI streams tool arguments as fragments; Gemini wants a whole `functionCall` part, so the
  // fragments are buffered per call index and flushed once the stream ends.
  const toolCalls = new Map<number, { id?: string; name?: string; argumentsText: string }>();

  const emitChunk = (chunk: Record<string, unknown>) => {
    const payload = input.wrapResponsePayload ? { response: chunk } : chunk;
    input.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const emitParts = (parts: Array<Record<string, unknown>>) => {
    if (parts.length <= 0) return;
    emitChunk({
      responseId: input.responseId,
      modelVersion: streamContext.model || input.modelName,
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts },
        },
      ],
    });
  };

  const handlePayload = (payload: unknown) => {
    if (!isRecord(payload)) return;
    usage = mergeProxyUsage(usage, parseProxyUsage(payload));

    const event = normalizeUpstreamStreamEvent(payload, streamContext, input.modelName);
    const parts: Array<Record<string, unknown>> = [];
    if (event.reasoningDelta) {
      parts.push({ text: event.reasoningDelta, thought: true });
    }
    if (event.contentDelta) {
      parts.push({ text: event.contentDelta });
    }
    if (parts.length > 0) emitParts(parts);

    for (const toolDelta of event.toolCallDeltas ?? []) {
      const current = toolCalls.get(toolDelta.index) ?? { argumentsText: '' };
      if (toolDelta.id) current.id = current.id ?? toolDelta.id;
      if (toolDelta.name) current.name = current.name ?? toolDelta.name;
      if (toolDelta.argumentsDelta) current.argumentsText += toolDelta.argumentsDelta;
      toolCalls.set(toolDelta.index, current);
    }

    if (event.finishReason) {
      finishReason = event.finishReason;
    }
  };

  const handleFrame = (frame: string) => {
    const data = payloadDataFromFrame(frame);
    if (!data) return;
    if (data.trim() === '[DONE]') {
      sawDone = true;
      return;
    }
    try {
      handlePayload(JSON.parse(data));
    } catch {
      // Keep-alives and provider-specific non-JSON frames carry no content; dropping them is
      // what the other stream surfaces do, and forwarding them would break Gemini clients.
    }
  };

  while (true) {
    const { done, value } = await input.reader.read();
    if (done) break;
    if (!value) continue;
    const chunkText = decoder.decode(value, { stream: true });
    rawStreamText += chunkText;
    const drained = drainSseFrames(rest + chunkText);
    rest = drained.rest;
    for (const frame of drained.frames) handleFrame(frame);
    if (sawDone) break;
  }

  if (!sawDone) {
    const tail = decoder.decode();
    if (tail) rawStreamText += tail;
    const drained = drainSseFrames(rest + tail);
    rest = drained.rest;
    for (const frame of drained.frames) handleFrame(frame);
  }
  if (rest.trim()) handleFrame(rest);

  const toolParts: Array<Record<string, unknown>> = [];
  for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    const parsedArgs = (() => {
      const text = call.argumentsText.trim();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })();
    toolParts.push({
      functionCall: {
        ...(call.id ? { id: call.id } : {}),
        name: call.name ?? '',
        args: parsedArgs,
      },
    });
  }
  if (toolParts.length > 0) emitParts(toolParts);

  const usageMetadata = buildUsageMetadata(usage);
  // Gemini closes a stream with the finish reason on the final candidate; a trailing
  // usage-only candidate is the least surprising way to report counts for content that was
  // already streamed (see the same trailing-usage shape in the chat/Responses surfaces).
  emitChunk({
    responseId: input.responseId,
    modelVersion: streamContext.model || input.modelName,
    candidates: [{ index: 0, finishReason: mapFinishReason(finishReason ?? (sawDone ? 'stop' : null)) }],
    ...(usageMetadata ? { usageMetadata } : {}),
  });

  return { usage, finishReason, rawStreamText };
}
