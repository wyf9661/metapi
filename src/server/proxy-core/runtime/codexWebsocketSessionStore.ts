import type { CodexWebsocketSession, CodexWebsocketSessionStore } from './types.js';

export function createCodexWebsocketSessionStore(): CodexWebsocketSessionStore {
  const sessions = new Map<string, CodexWebsocketSession>();

  return {
    getOrCreate(sessionId) {
      const normalized = sessionId.trim();
      const existing = sessions.get(normalized);
      if (existing) return existing;

      const created: CodexWebsocketSession = {
        sessionId: normalized,
        socket: null,
        socketUrl: null,
        queue: Promise.resolve(),
      };
      sessions.set(normalized, created);
      return created;
    },
    take(sessionId) {
      const normalized = sessionId.trim();
      if (!normalized) return null;
      const existing = sessions.get(normalized) || null;
      if (existing) {
        sessions.delete(normalized);
      }
      return existing;
    },
    list() {
      return [...sessions.values()];
    },
  };
}
