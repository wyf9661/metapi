import { describe, expect, it } from 'vitest';

import { createProxyStreamLifecycle } from './protocolLifecycle.js';

/**
 * An upstream that opens the stream and then stops sending used to leave `reader.read()`
 * pending forever: the client connection, the channel lease and the retry slot stayed held.
 * A single read now has a deadline, after which the lifecycle stops like EOF.
 */
describe('proxy stream idle deadline', () => {
  it('stops reading when the upstream goes silent', async () => {
    let ended = false;
    let cancelled = false;
    const lifecycle = createProxyStreamLifecycle<{ data: string }>({
      reader: {
        read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}),
        cancel: async () => { cancelled = true; },
        releaseLock: () => {},
      },
      response: { end: () => { ended = true; } },
      pullEvents: () => ({ events: [], rest: '' }),
      handleEvent: () => false,
      idleTimeoutMs: 20,
    });

    await lifecycle.run();
    expect(cancelled).toBe(true);
    expect(ended).toBe(true);
  });

  it('reports the stall so it is not mistaken for a clean early EOF', async () => {
    const reported: number[] = [];
    const lifecycle = createProxyStreamLifecycle<{ data: string }>({
      reader: {
        read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}),
        cancel: async () => {},
        releaseLock: () => {},
      },
      response: { end: () => {} },
      pullEvents: () => ({ events: [], rest: '' }),
      handleEvent: () => false,
      idleTimeoutMs: 15,
      onFirstByteTimeout: (elapsedMs) => { reported.push(elapsedMs); },
    });

    await lifecycle.run();
    expect(reported).toEqual([15]);
  });

  it('still reads normally when data keeps arriving', async () => {
    const seen: string[] = [];
    const chunk = new TextEncoder().encode('data: {"a":1}\n\n');
    let reads = 0;
    const lifecycle = createProxyStreamLifecycle<{ data: string }>({
      reader: {
        read: async () => (reads++ === 0 ? { done: false, value: chunk } : { done: true }),
        cancel: async () => {},
        releaseLock: () => {},
      },
      response: { end: () => {} },
      pullEvents: (buffer) => {
        const events: Array<{ data: string }> = [];
        const parts = buffer.split('\n\n');
        const rest = parts.pop() ?? '';
        for (const part of parts) {
          if (part.startsWith('data: ')) events.push({ data: part.slice(6) });
        }
        return { events, rest };
      },
      handleEvent: (event) => { seen.push(event.data); return false; },
      idleTimeoutMs: 50,
    });

    await lifecycle.run();
    expect(seen).toEqual(['{"a":1}']);
  });

  it('does not cut a stream that already delivered data and is thinking', async () => {
    // Mid-stream silence is normal for reasoning models; only the first byte is bounded.
    const started = Date.now();
    let reads = 0;
    const lifecycle = createProxyStreamLifecycle<{ data: string }>({
      reader: {
        read: async () => {
          reads += 1;
          if (reads === 1) return { done: false, value: new TextEncoder().encode('data: {"a":1}\n\n') };
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { done: true };
        },
        cancel: async () => {},
        releaseLock: () => {},
      },
      response: { end: () => {} },
      pullEvents: () => ({ events: [], rest: '' }),
      handleEvent: () => false,
      idleTimeoutMs: 20,
    });

    await lifecycle.run();
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });
});