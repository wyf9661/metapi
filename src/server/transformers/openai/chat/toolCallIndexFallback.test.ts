import { describe, expect, it } from 'vitest';
import { extractChatChoiceEvents } from './helpers.js';
import { normalizeUpstreamStreamEvent } from '../../shared/chatFormatsCore.js';
import { createStreamTransformContext } from '../../shared/normalized.js';

/**
 * Regression: one call's argument fragments arriving in ONE chunk with no `index` and no
 * `id` used to be numbered 0..n (array position), so a client saw n parallel tool calls
 * each holding a raw JSON fragment. Nothing parsed, the turn read as a truncated tool call
 * and the real call was dropped. The fragments must collapse onto one slot.
 */
const fragmentedChunk = {
  id: 'chatcmpl-test',
  object: 'chat.completion.chunk',
  created: 1_760_000_000,
  model: 'test-model',
  choices: [
    {
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [
          { function: { arguments: '{"command": "' } },
          { function: { arguments: 'ls ~/.hermes/skills/anysearch/ 2>/dev' } },
          { function: { arguments: '/null || find ~/.hermes -maxdepth 4' } },
          { function: { arguments: '"}' } },
        ],
      },
      finish_reason: null,
    },
  ],
};

describe('tool-call index fallback for index-less fragments', () => {
  it('collapses index-less argument fragments of one call onto a single slot', () => {
    const events = extractChatChoiceEvents(fragmentedChunk);
    expect(events).toHaveLength(1);
    const deltas = events[0].toolCallDeltas ?? [];
    expect(deltas).toHaveLength(4);
    expect(deltas.map((delta) => delta.index)).toEqual([0, 0, 0, 0]);
    expect(deltas.map((delta) => delta.argumentsDelta).join(''))
      .toBe('{"command": "ls ~/.hermes/skills/anysearch/ 2>/dev/null || find ~/.hermes -maxdepth 4"}');
  });

  it('keeps explicit indices authoritative', () => {
    const events = extractChatChoiceEvents({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 1, id: 'call_b', function: { name: 'terminal', arguments: '{"command":"ls"}' } },
            { index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":"/tmp/x"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const deltas = events[0].toolCallDeltas ?? [];
    expect(deltas.map((delta) => delta.index)).toEqual([1, 0]);
  });

  it('still splits genuine parallel calls that carry distinct ids', () => {
    const events = extractChatChoiceEvents({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { id: 'call_a', function: { name: 'terminal', arguments: '{"command":"ls"}' } },
            { id: 'call_b', function: { name: 'terminal', arguments: '{"command":"pwd"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const deltas = events[0].toolCallDeltas ?? [];
    expect(deltas.map((delta) => delta.index)).toEqual([0, 1]);
  });

  it('does not merge a new id into an active slot already owned by another call', () => {
    const events = extractChatChoiceEvents({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { id: 'call_a', function: { name: 'terminal', arguments: '{' } },
            { id: 'call_b', function: { arguments: '}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });
    expect(events[0].toolCallDeltas?.map((delta) => delta.index)).toEqual([0, 1]);
  });

  it('rejoins a fragment that repeats an earlier id instead of opening a new slot', () => {
    const events = extractChatChoiceEvents({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { id: 'call_a', function: { name: 'terminal', arguments: '' } },
            { id: 'call_a', function: { arguments: '{"command":' } },
            { id: 'call_a', function: { arguments: ' "ls"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const deltas = events[0].toolCallDeltas ?? [];
    expect(deltas.map((delta) => delta.index)).toEqual([0, 0, 0]);
  });

  it('applies the same rule on the normalizing core path', () => {
    const context = createStreamTransformContext('test-model');
    const event = normalizeUpstreamStreamEvent(fragmentedChunk, context, 'test-model');
    const deltas = event.toolCallDeltas ?? [];
    expect(deltas.map((delta) => delta.index)).toEqual([0, 0, 0, 0]);
    expect(deltas.map((delta) => delta.argumentsDelta).join(''))
      .toBe('{"command": "ls ~/.hermes/skills/anysearch/ 2>/dev/null || find ~/.hermes -maxdepth 4"}');
  });
});
