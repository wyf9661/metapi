import { describe, expect, it, vi } from 'vitest';

import { createCodexWebsocketSessionStore } from './codexWebsocketSessionStore.js';

describe('codex websocket session store idle eviction', () => {
  it('evicts an idle session and closes its socket on the next access', () => {
    let now = 1_000;
    const close = vi.fn().mockResolvedValue(undefined);
    const store = createCodexWebsocketSessionStore({ now: () => now, idleTtlMs: 1_000 });
    const session = store.getOrCreate('session-1');
    session.socket = { close } as never;
    session.socketUrl = 'wss://upstream.example.com/socket';

    now += 5_000;

    expect(store.list()).toHaveLength(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(session.socket).toBeNull();
  });

  it('keeps a session that has an in-flight send, however old', () => {
    let now = 1_000;
    const store = createCodexWebsocketSessionStore({ now: () => now, idleTtlMs: 1_000 });
    const session = store.getOrCreate('session-1');
    session.inFlight = 1;

    now += 60 * 60 * 1000;

    expect(store.list()).toHaveLength(1);
  });

  it('refreshes lastUsedAt on reuse so an actively used session survives', () => {
    let now = 1_000;
    const store = createCodexWebsocketSessionStore({ now: () => now, idleTtlMs: 1_000 });
    const session = store.getOrCreate('session-1');

    now += 900;
    expect(store.getOrCreate('session-1')).toBe(session);
    now += 900;
    expect(store.list()).toHaveLength(1);

    now += 1_100;
    expect(store.list()).toHaveLength(0);
  });

  it('never throws when an evicted socket closes with an error', () => {
    let now = 1_000;
    const store = createCodexWebsocketSessionStore({ now: () => now, idleTtlMs: 1_000 });
    const session = store.getOrCreate('session-1');
    session.socket = {
      close: () => {
        throw new Error('socket already gone');
      },
    } as never;

    now += 5_000;

    expect(() => store.list()).not.toThrow();
    expect(store.list()).toHaveLength(0);
  });

  it('caps the map and evicts the oldest sessions, skipping in-flight ones', () => {
    const store = createCodexWebsocketSessionStore({ maxSessions: 3 });
    store.getOrCreate('oldest');
    store.getOrCreate('busy').inFlight = 1;
    store.getOrCreate('third');
    store.getOrCreate('fourth');
    store.getOrCreate('newest');

    const remaining = store.list().map((session) => session.sessionId);

    expect(store.list().length).toBeLessThanOrEqual(3);
    expect(remaining).not.toContain('oldest');
    expect(remaining).toContain('busy');
    expect(remaining).toContain('newest');
  });
});
