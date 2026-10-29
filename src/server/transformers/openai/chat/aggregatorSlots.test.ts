import { describe, expect, it } from 'vitest';

import {
  applyOpenAiChatStreamEvent,
  createOpenAiChatAggregateState,
  finalizeOpenAiChatAggregate,
} from './aggregator.js';

/**
 * Fragments of ONE tool call must land in ONE slot even when the upstream omits `index`.
 *
 * Regression: the aggregate numbered index-less fragments by `toolCalls.length`, so the
 * several argument fragments of a single call produced n "parallel" calls each holding a
 * JSON fragment. Every one was unparseable, so the client saw a truncated tool call and the
 * real call was lost — the 2026-10-29 fragmented-tool-call failure.
 */
describe('openai chat aggregate tool-call slots', () => {
  const fragment = (argumentsDelta: string, id?: string, name?: string) =>
    applyOpenAiChatStreamEvent(createOpenAiChatAggregateState(), {
      toolCallDeltas: [{ index: undefined as unknown as number, id, name, argumentsDelta }],
    });

  it('keeps index-less argument fragments of one call together', () => {
    const state = createOpenAiChatAggregateState();
    const push = (delta: Record<string, unknown>) => {
      applyOpenAiChatStreamEvent(state, {
        toolCallDeltas: [delta as unknown as { index: number; argumentsDelta?: string }],
      });
    };

    push({ id: 'call_a', name: 'get_weather', argumentsDelta: '{"city":' });
    push({ argumentsDelta: '"Wuhan"' });
    push({ argumentsDelta: '}' });

    const finalized = finalizeOpenAiChatAggregate(state, {
      id: 'x', model: 'm', created: 0, content: '', reasoningContent: '',
      finishReason: 'tool_calls', toolCalls: [],
    });

    expect(finalized.toolCalls).toHaveLength(1);
    expect(finalized.toolCalls[0].arguments).toBe('{"city":"Wuhan"}');
  });

  it('still separates a genuinely new call', () => {
    const state = createOpenAiChatAggregateState();
    applyOpenAiChatStreamEvent(state, {
      toolCallDeltas: [{ index: undefined as unknown as number, id: 'call_a', name: 'a', argumentsDelta: '{}' }],
    });
    applyOpenAiChatStreamEvent(state, {
      toolCallDeltas: [{ index: undefined as unknown as number, id: 'call_b', name: 'b', argumentsDelta: '{}' }],
    });

    const finalized = finalizeOpenAiChatAggregate(state, {
      id: 'x', model: 'm', created: 0, content: '', reasoningContent: '',
      finishReason: 'tool_calls', toolCalls: [],
    });
    expect(finalized.toolCalls.map((call) => call.id)).toEqual(['call_a', 'call_b']);
  });

  it('honours an explicit index when the upstream sends one', () => {
    const state = createOpenAiChatAggregateState();
    applyOpenAiChatStreamEvent(state, {
      toolCallDeltas: [
        { index: 1, id: 'call_b', name: 'b', argumentsDelta: '{"y":2}' },
        { index: 0, id: 'call_a', name: 'a', argumentsDelta: '{"x":1}' },
      ],
    });

    const finalized = finalizeOpenAiChatAggregate(state, {
      id: 'x', model: 'm', created: 0, content: '', reasoningContent: '',
      finishReason: 'tool_calls', toolCalls: [],
    });
    expect(finalized.toolCalls[0].id).toBe('call_a');
    expect(finalized.toolCalls[1].id).toBe('call_b');
  });
});
