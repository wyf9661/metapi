import { describe, expect, it } from 'vitest';

import {
  createStreamTransformContext,
  normalizeUpstreamStreamEvent,
} from './chatFormatsCore.js';

/**
 * Regression for P0-3: Anthropic numbers every content block (thinking=0, text=1,
 * tool_use=2), so handing that index straight through produced a sparse tool_calls array.
 * Only tool_use blocks may occupy a slot, in opening order.
 */
function anthropicSse(type: string, payload: Record<string, unknown>) {
  return { type, ...payload };
}

describe('anthropic content blocks -> dense tool slots', () => {
  it('numbers tool calls from 0 even when thinking and text blocks come first', () => {
    const context = createStreamTransformContext('claude-test');

    // thinking block (index 0), text block (index 1)
    normalizeUpstreamStreamEvent(anthropicSse('content_block_start', {
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }), context, 'claude-test');
    normalizeUpstreamStreamEvent(anthropicSse('content_block_start', {
      index: 1,
      content_block: { type: 'text', text: '' },
    }), context, 'claude-test');

    // first real tool: block index 2 -> slot 0
    const start = normalizeUpstreamStreamEvent(anthropicSse('content_block_start', {
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_A', name: 'terminal', input: {} },
    }), context, 'claude-test');
    expect(start.toolCallDeltas?.map((d) => d.index)).toEqual([0]);

    // its argument chunks must keep landing on slot 0, not block index 2
    const delta = normalizeUpstreamStreamEvent(anthropicSse('content_block_delta', {
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
    }), context, 'claude-test');
    expect(delta.toolCallDeltas?.map((d) => d.index)).toEqual([0]);
  });

  it('gives a second parallel tool the next dense slot', () => {
    const context = createStreamTransformContext('claude-test');

    normalizeUpstreamStreamEvent(anthropicSse('content_block_start', {
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_A', name: 'terminal', input: {} },
    }), context, 'claude-test');
    const second = normalizeUpstreamStreamEvent(anthropicSse('content_block_start', {
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_B', name: 'read_file', input: {} },
    }), context, 'claude-test');

    expect(second.toolCallDeltas?.map((d) => d.index)).toEqual([1]);

    // interleaved deltas keep their own slots
    const a = normalizeUpstreamStreamEvent(anthropicSse('content_block_delta', {
      index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' },
    }), context, 'claude-test');
    const b = normalizeUpstreamStreamEvent(anthropicSse('content_block_delta', {
      index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' },
    }), context, 'claude-test');
    expect(a.toolCallDeltas?.[0]?.index).toBe(0);
    expect(b.toolCallDeltas?.[0]?.index).toBe(1);
  });

  it('does not allocate a slot for a text-only block delta', () => {
    // A block delta that never had a content_block_start must not open a tool slot lazily
    // in a way that shifts later tool ordinals.
    const context = createStreamTransformContext('claude-test');
    normalizeUpstreamStreamEvent(anthropicSse('content_block_delta', {
      index: 5, delta: { type: 'text_delta', text: 'hello' },
    }), context, 'claude-test');

    const tool = normalizeUpstreamStreamEvent(anthropicSse('content_block_start', {
      index: 6,
      content_block: { type: 'tool_use', id: 'toolu_C', name: 'terminal', input: {} },
    }), context, 'claude-test');
    expect(tool.toolCallDeltas?.map((d) => d.index)).toEqual([0]);
  });
});
