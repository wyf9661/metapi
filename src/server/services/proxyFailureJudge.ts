import { config } from '../config.js';
import { pullSseDataEvents } from './proxyUsageParser.js';
import { hasMalformedToolCallArguments } from '../transformers/shared/toolCallAssembler.js';

type FailureResult = {
  status: number;
  reason: string;
};

type UsageSummary = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

function normalizeKeywords(values: string[]): string[] {
  return values
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
    .map((item) => item.toLowerCase());
}

function toNonNegativeInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasToolCallLike(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return false;
}

function hasCompletionContentFromChoice(choice: any): boolean {
  if (hasNonEmptyString(choice?.text)) return true;
  if (hasNonEmptyString(choice?.completion)) return true;
  if (hasNonEmptyString(choice?.output_text)) return true;

  const message = choice?.message;
  if (hasNonEmptyString(message?.content)) return true;
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (hasNonEmptyString(part?.text) || hasNonEmptyString(part?.output_text) || hasNonEmptyString(part?.content)) {
        return true;
      }
    }
  }

  if (hasNonEmptyString(message?.refusal)) return true;
  if (hasToolCallLike(message?.tool_calls)) return true;
  if (hasToolCallLike(message?.toolCalls)) return true;
  if (hasToolCallLike(message?.function_call)) return true;
  if (hasToolCallLike(message?.functionCall)) return true;

  if (hasToolCallLike(choice?.tool_calls)) return true;
  if (hasToolCallLike(choice?.toolCalls)) return true;
  if (hasToolCallLike(choice?.function_call)) return true;
  if (hasToolCallLike(choice?.functionCall)) return true;

  const delta = choice?.delta;
  if (hasNonEmptyString(delta?.content)) return true;
  if (hasNonEmptyString(delta?.refusal)) return true;
  if (hasToolCallLike(delta?.tool_calls)) return true;
  if (hasToolCallLike(delta?.toolCalls)) return true;
  if (hasToolCallLike(delta?.function_call)) return true;
  if (hasToolCallLike(delta?.functionCall)) return true;

  return false;
}

function hasCompletionContentFromPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const obj: any = payload;

  if (Array.isArray(obj?.choices)) {
    for (const choice of obj.choices) {
      if (hasCompletionContentFromChoice(choice)) return true;
    }
    if (hasCompletionContentFromChoice(obj)) return true;
  }

  if (hasNonEmptyString(obj?.output_text)) return true;
  if (hasNonEmptyString(obj?.outputText)) return true;

  if (Array.isArray(obj?.output)) {
    for (const item of obj.output) {
      if (!isRecord(item)) continue;
      const type = String((item as any).type || '').toLowerCase();
      if (type.includes('function_call') || type.includes('tool_call')) return true;

      if (hasNonEmptyString((item as any).text) || hasNonEmptyString((item as any).output_text)) return true;

      if (Array.isArray((item as any).content)) {
        for (const part of (item as any).content) {
          if (hasNonEmptyString((part as any)?.text) || hasNonEmptyString((part as any)?.output_text) || hasNonEmptyString((part as any)?.content)) {
            return true;
          }
          const partType = String((part as any)?.type || '').toLowerCase();
          if (partType.includes('function_call') || partType.includes('tool_call')) return true;
        }
      }

      if (hasToolCallLike((item as any).tool_calls) || hasToolCallLike((item as any).toolCalls)) return true;
      if (hasToolCallLike((item as any).function_call) || hasToolCallLike((item as any).functionCall)) return true;
    }
  }

  if (Array.isArray(obj?.content)) {
    for (const part of obj.content) {
      if (hasNonEmptyString((part as any)?.text) || hasNonEmptyString((part as any)?.output_text) || hasNonEmptyString((part as any)?.content)) {
        return true;
      }
      const partType = String((part as any)?.type || '').toLowerCase();
      if (partType.includes('function_call') || partType.includes('tool_call')) return true;
    }
  }

  if (hasNonEmptyString(obj?.delta)) return true;
  if (hasNonEmptyString(obj?.text)) return true;
  if (hasToolCallLike(obj?.tool_calls) || hasToolCallLike(obj?.toolCalls)) return true;
  if (hasToolCallLike(obj?.function_call) || hasToolCallLike(obj?.functionCall)) return true;

  return false;
}

function detectHasUpstreamOutput(rawText: string): boolean {
  const text = typeof rawText === 'string' ? rawText : '';
  const trimmed = text.trim();
  if (!trimmed) return false;

  try {
    const parsed = JSON.parse(trimmed);
    return hasCompletionContentFromPayload(parsed);
  } catch {
    // Important: don't trim before SSE parsing, otherwise `data: [DONE]\n\n` can be lost.
    const pulled = pullSseDataEvents(text);
    if (pulled.events.length > 0) {
      for (const event of pulled.events) {
        const payload = event.trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsedEvent = JSON.parse(payload);
          if (hasCompletionContentFromPayload(parsedEvent)) return true;
        } catch {
          // Non-JSON payload still counts as upstream output.
          return true;
        }
      }
      // SSE payloads exist but none contain output.
      return false;
    }

    // Looks like SSE but contains no non-DONE payloads.
    if (text.includes('data:')) return false;

    // Not JSON and not SSE: assume it's plain text output.
    return true;
  }
}

// Tool-call argument strings from a payload in either shape: final (chat
// `message.tool_calls[].function.arguments`, responses `function_call` items)
// or delta (appended into a slot keyed by its index/id, so fragments of one
// healthy call reassemble while a relay-damaged split stays broken).
function collectToolCallArguments(payload: unknown, slots: Map<string, string>): void {
  if (!isRecord(payload)) return;
  const obj = payload as any;
  const take = (key: string, value: unknown) => {
    if (typeof value !== 'string') return;
    slots.set(key, (slots.get(key) || '') + value);
  };
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  for (const choice of choices) {
    for (const source of [choice?.message?.tool_calls, choice?.delta?.tool_calls]) {
      if (!Array.isArray(source)) continue;
      const final = source === choice?.message?.tool_calls;
      source.forEach((toolCall: any, position: number) => {
        // Deltas slot by `index` (later fragments carry no id); final messages slot by id.
        const key = final
          ? `f:${String(toolCall?.id || position)}`
          : `d:${toolCall?.index ?? position}`;
        take(key, typeof toolCall?.function?.arguments === 'string' ? toolCall.function.arguments : toolCall?.arguments);
      });
    }
  }
  if (Array.isArray(obj.output)) {
    for (const item of obj.output) {
      if (!isRecord(item)) continue;
      const type = String((item as any).type || '').toLowerCase();
      if (type === 'function_call') take(String((item as any).id || 'output'), (item as any).arguments);
    }
  }
  for (const toolCall of Array.isArray(obj.tool_calls) ? obj.tool_calls : []) {
    const key = String(toolCall?.id ?? toolCall?.index ?? 0);
    take(key, typeof toolCall?.function?.arguments === 'string' ? toolCall.function.arguments : toolCall?.arguments);
  }
}

function detectHasMalformedToolCall(rawText: string): boolean {
  const text = typeof rawText === 'string' ? rawText : '';
  const trimmed = text.trim();
  if (!trimmed) return false;
  const payloads: unknown[] = [];
  try {
    payloads.push(JSON.parse(trimmed));
  } catch {
    const pulled = pullSseDataEvents(text);
    for (const event of pulled.events) {
      const payload = event.trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        payloads.push(JSON.parse(payload));
      } catch {
        // Non-JSON event frame: no tool-call signal to read.
      }
    }
  }
  if (payloads.length === 0) return false;
  const slots = new Map<string, string>();
  for (const payload of payloads) collectToolCallArguments(payload, slots);
  return hasMalformedToolCallArguments(slots.values());
}

function hasCompletionReasoningFromChoice(choice: any): boolean {
  if (hasNonEmptyString(choice?.reasoning_content)) return true;
  if (hasNonEmptyString(choice?.reasoning)) return true;
  const message = choice?.message;
  if (hasNonEmptyString(message?.reasoning_content)) return true;
  if (hasNonEmptyString(message?.reasoning)) return true;
  const delta = choice?.delta;
  if (hasNonEmptyString(delta?.reasoning_content)) return true;
  if (hasNonEmptyString(delta?.reasoning)) return true;
  return false;
}

function hasCompletionReasoningFromPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const obj: any = payload;
  if (Array.isArray(obj?.choices)) {
    for (const choice of obj.choices) {
      if (hasCompletionReasoningFromChoice(choice)) return true;
    }
    if (hasCompletionReasoningFromChoice(obj)) return true;
  }
  if (hasNonEmptyString(obj?.reasoning_content)) return true;
  if (Array.isArray(obj?.output)) {
    for (const item of obj.output) {
      if (!isRecord(item)) continue;
      if (String((item as any).type || '').toLowerCase() === 'reasoning') return true;
    }
  }
  return false;
}

function detectHasUpstreamReasoning(rawText: string): boolean {
  const text = typeof rawText === 'string' ? rawText : '';
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    return hasCompletionReasoningFromPayload(JSON.parse(trimmed));
  } catch {
    // Non-JSON bodies fall through to SSE parsing below.
  }
  const pulled = pullSseDataEvents(text);
  for (const event of pulled.events) {
    const payload = event.trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      if (hasCompletionReasoningFromPayload(JSON.parse(payload))) return true;
    } catch {
      // Non-JSON event: no reasoning signal to read.
    }
  }
  return false;
}

export function detectProxyFailure(input: {
  rawText: string;
  usage?: UsageSummary | null;
  // Backward-compatible fields (older call sites)
  completionTokens?: number;
  totalTokens?: number;
  // True when the downstream client already closed the connection. An empty
  // response then reflects the client cancel, not an upstream defect, so the
  // empty-content heuristic must not flag it (no failover, no channel failure).
  downstreamAborted?: boolean;
}): FailureResult | null {
  const rawText = typeof input.rawText === 'string' ? input.rawText : '';
  const keywords = normalizeKeywords(config.proxyErrorKeywords || []);
  if (keywords.length > 0) {
    const normalizedText = rawText.toLowerCase();
    const matched = keywords.find((keyword) => normalizedText.includes(keyword));
    if (matched) {
      return {
        status: 502,
        reason: `Upstream response matched failure keyword: ${matched}`,
      };
    }
  }

  if (config.proxyEmptyContentFailEnabled && !input.downstreamAborted) {
    const completionTokens = toNonNegativeInt(input.usage?.completionTokens ?? input.completionTokens);
    const hasOutput = detectHasUpstreamOutput(rawText);
    // Reasoning (thinking chain) is not deliverable output: a response that
    // only produced reasoning never delivered a final answer. Flag it as an
    // empty-content failure (channel-level, sibling channels stay usable) so
    // the attempt can fail over instead of passing a thinking-only response
    // to the client as success.
    const reasoningOnly = !hasOutput && detectHasUpstreamReasoning(rawText);

    if (!hasOutput && (completionTokens <= 0 || reasoningOnly)) {
      return {
        status: 502,
        reason: reasoningOnly
          ? 'Upstream returned empty content (reasoning only)'
          : 'Upstream returned empty content',
      };
    }

    // Visible but unexecutable: a damaged relay split one tool call into slots
    // that never reassemble into valid JSON. Same channel-level class as the
    // empty-content gate so sibling channels stay usable.
    if (detectHasMalformedToolCall(rawText)) {
      return {
        status: 502,
        reason: 'Upstream returned malformed tool call arguments',
      };
    }
  }

  return null;
}
