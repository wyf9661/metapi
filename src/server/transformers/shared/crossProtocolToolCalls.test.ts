import { describe, expect, it } from 'vitest';

import {
  createStreamTransformContext,
  normalizeUpstreamStreamEvent,
} from './chatFormatsCore.js';
import type { NormalizedStreamEvent } from './chatFormatsCore.js';

/**
 * Cross-protocol invariant: normalizing the SAME logical tool call from three different
 * upstream wire shapes must produce the same canonical tool-call set — one call at index 0
 * whose argument JSON parses to `{command:"ls"}`. Exits are then pure projections, so a bug
 * fixed here cannot survive in one protocol and not another.
 */

type Deltas = NonNullable<NormalizedStreamEvent['toolCallDeltas']>;

function assemble(deltas: Deltas[]): Array<{ index: number; arguments: string }> {
  const byIndex = new Map<number, string>();
  for (const group of deltas) {
    for (const delta of group) {
      const prev = byIndex.get(delta.index) ?? '';
      byIndex.set(delta.index, prev + (delta.argumentsDelta ?? ''));
    }
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, args]) => ({ index, arguments: args }));
}

describe('one tool call, three upstream protocols', () => {
  it('openai chat chunks', () => {
    const context = createStreamTransformContext('m');
    const events = [
      { choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'terminal', arguments: '' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ' "ls"}' } }] }, finish_reason: 'tool_calls' }] },
    ];
    const deltas = events.map((payload) => normalizeUpstreamStreamEvent(payload, context, 'm'))
      .map((event) => event.toolCallDeltas ?? [])
      .filter((group) => group.length > 0);

    const calls = assemble(deltas);
    expect(calls).toHaveLength(1);
    expect(calls[0].index).toBe(0);
    expect(JSON.parse(calls[0].arguments)).toEqual({ command: 'ls' });
  });

  it('anthropic content blocks, with thinking and text blocks first', () => {
    const context = createStreamTransformContext('m');
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_x', name: 'terminal', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ' "ls"}' } },
    ];
    const deltas = events.map((payload) => normalizeUpstreamStreamEvent(payload, context, 'm'))
      .map((event) => event.toolCallDeltas ?? [])
      .filter((group) => group.length > 0);

    const calls = assemble(deltas);
    expect(calls).toHaveLength(1);
    // regression: this used to be index 2 (the raw content-block ordinal)
    expect(calls[0].index).toBe(0);
    expect(JSON.parse(calls[0].arguments)).toEqual({ command: 'ls' });
  });

  it('gemini streamed candidates deliver the call whole, exactly once', () => {
    const context = createStreamTransformContext('m');
    const chunk = {
      modelVersion: 'gemini-x',
      candidates: [{
        content: { parts: [{ functionCall: { name: 'terminal', args: { command: 'ls' } } }] },
        finishReason: 'STOP',
      }],
    };
    const first = normalizeUpstreamStreamEvent(chunk, context, 'm');
    const repeat = normalizeUpstreamStreamEvent(chunk, context, 'm');

    const deltas = [first.toolCallDeltas ?? [], repeat.toolCallDeltas ?? []]
      .filter((group) => group.length > 0);
    // The repeated frame is a snapshot of the same call: it must not be re-emitted,
    // otherwise the downstream accumulator appends the payload a second time.
    expect(deltas).toHaveLength(1);

    const calls = assemble(deltas);
    expect(calls).toHaveLength(1);
    expect(calls[0].index).toBe(0);
    expect(JSON.parse(calls[0].arguments)).toEqual({ command: 'ls' });
  });
});
