import { describe, expect, it } from 'vitest';

import {
  applyToolCallFragment,
  createToolCallAssembler,
  finalizeToolCalls,
} from './toolCallAssembler.js';

describe('tool call assembler — index assignment', () => {
  it('collapses index-less fragments of one call onto a single slot', () => {
    // The 2026-10-29 production failure: one call's four argument fragments inside one
    // chunk, none carrying index or id. Numbering them by array position produced four
    // "parallel" calls holding half a JSON document each.
    const a = createToolCallAssembler();
    for (const frag of ['{"command": "', 'ls ~/.hermes/skills/', 'null || find .', '"}']) {
      applyToolCallFragment(a, { argumentsDelta: frag });
    }
    const calls = finalizeToolCalls(a);
    expect(calls).toHaveLength(1);
    expect(calls[0].index).toBe(0);
    expect(calls[0].arguments).toBe('{"command": "ls ~/.hermes/skills/null || find ."}');
    expect(calls[0].parses).toBe(true);
  });

  it('keeps genuine parallel calls apart when each carries an id and a name', () => {
    const a = createToolCallAssembler();
    applyToolCallFragment(a, { id: 'call_a', name: 'terminal' });
    applyToolCallFragment(a, { argumentsDelta: '{"command":"ls"}' });
    applyToolCallFragment(a, { id: 'call_b', name: 'read_file' });
    applyToolCallFragment(a, { argumentsDelta: '{"path":"/tmp/x"}' });

    const calls = finalizeToolCalls(a);
    expect(calls.map((c) => c.index)).toEqual([0, 1]);
    expect(calls[0].arguments).toBe('{"command":"ls"}');
    expect(calls[1].arguments).toBe('{"path":"/tmp/x"}');
    expect(calls.every((c) => c.parses)).toBe(true);
  });

  it('rejoins a fragment that repeats an earlier call id', () => {
    const a = createToolCallAssembler();
    applyToolCallFragment(a, { id: 'call_a', name: 'terminal' });
    applyToolCallFragment(a, { argumentsDelta: '{"command":' });
    applyToolCallFragment(a, { id: 'call_a', argumentsDelta: ' "ls"}' });

    const calls = finalizeToolCalls(a);
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toBe('{"command": "ls"}');
  });

  it('honours an explicit upstream index', () => {
    const a = createToolCallAssembler();
    applyToolCallFragment(a, { index: 1, id: 'call_b', name: 'terminal', argumentsDelta: '{}' });
    applyToolCallFragment(a, { index: 0, id: 'call_a', name: 'read_file', argumentsDelta: '{}' });

    const calls = finalizeToolCalls(a);
    expect(calls.map((c) => c.index).sort()).toEqual([0, 1]);
    expect(calls.find((c) => c.index === 1)?.id).toBe('call_b');
  });
});

describe('tool call assembler — argument assembly', () => {
  it('replaces the buffer on a snapshot frame instead of appending twice', () => {
    // Regression: a cumulative `*.done` frame compared against an accumulating buffer, and
    // when done arrived in the same tick as a delta the equality check failed and the whole
    // payload was appended a second time, producing `{...}{...}`.
    const a = createToolCallAssembler();
    applyToolCallFragment(a, { id: 'call_a', name: 'terminal' });
    applyToolCallFragment(a, { argumentsDelta: '{"command":' });
    applyToolCallFragment(a, { argumentsDelta: ' "ls"}' });
    expect(finalizeToolCalls(a)[0].arguments).toBe('{"command": "ls"}');

    // Snapshot arrives carrying the same complete payload: buffer must not grow.
    applyToolCallFragment(a, { argumentsDelta: '{"command": "ls"}' }, { snapshot: true });
    expect(finalizeToolCalls(a)[0].arguments).toBe('{"command": "ls"}');
  });

  it('keeps appending after a snapshot', () => {
    const a = createToolCallAssembler();
    applyToolCallFragment(a, { id: 'c', name: 'n', argumentsDelta: '{"a":1' }, { snapshot: true });
    applyToolCallFragment(a, { argumentsDelta: ',"b":2}' });
    const call = finalizeToolCalls(a)[0];
    expect(call.arguments).toBe('{"a":1,"b":2}');
    expect(call.parses).toBe(true);
  });

  it('flags unparseable arguments instead of pretending they are valid', () => {
    const a = createToolCallAssembler();
    applyToolCallFragment(a, { id: 'c', name: 'n', argumentsDelta: '{"command": "ls' });
    const call = finalizeToolCalls(a)[0];
    expect(call.parses).toBe(false);
    expect(call.arguments).toBe('{"command": "ls');
  });

  it('treats an empty argument string as a parseable empty object', () => {
    const a = createToolCallAssembler();
    applyToolCallFragment(a, { id: 'c', name: 'n' });
    const call = finalizeToolCalls(a)[0];
    expect(call.arguments).toBe('');
    expect(call.parses).toBe(true);
  });

  it('preserves the order slots were opened', () => {
    const a = createToolCallAssembler();
    applyToolCallFragment(a, { id: 'c1', name: 'first' });
    applyToolCallFragment(a, { id: 'c2', name: 'second' });
    applyToolCallFragment(a, { id: 'c3', name: 'third' });
    expect(finalizeToolCalls(a).map((c) => c.name)).toEqual(['first', 'second', 'third']);
  });

  it('ignores a fragment that carries nothing', () => {
    const a = createToolCallAssembler();
    expect(applyToolCallFragment(a, {})).toBeNull();
    expect(finalizeToolCalls(a)).toEqual([]);
  });
});
