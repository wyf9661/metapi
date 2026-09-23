import type { CodexWebsocketSession, CodexWebsocketSessionStore } from './types.js';

/**
 * A session idle for this long with no in-flight send is evicted on the next
 * store access — closes its socket so half-open connections (client vanishes
 * without a close frame) cannot accumulate in the map forever.
 */
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

/**
 * Same bounded-store pattern as codexSessionResponseStore
 * (MAX_CODEX_SESSION_RESPONSE_IDS): a flood of distinct session ids must not
 * grow the map without limit.
 */
const MAX_CODEX_WEBSOCKET_SESSIONS = 512;

function closeSocketBestEffort(session: CodexWebsocketSession): void {
  const socket = session.socket;
  if (!socket) return;
  session.socket = null;
  session.socketUrl = null;
  try {
    const result = (socket as { close?: (code?: number, reason?: string) => unknown }).close?.();
    if (result && typeof (result as Promise<unknown>)?.catch === 'function') {
      (result as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // Eviction is best-effort; a stale socket must never block the store.
  }
}

export function createCodexWebsocketSessionStore(input?: {
  now?: () => number;
  idleTtlMs?: number;
  maxSessions?: number;
}): CodexWebsocketSessionStore {
  const now = input?.now ?? Date.now;
  const idleTtlMs = input?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const maxSessions = input?.maxSessions ?? MAX_CODEX_WEBSOCKET_SESSIONS;
  const sessions = new Map<string, CodexWebsocketSession>();

  const sweepIdle = (): void => {
    const cutoff = now() - idleTtlMs;
    for (const [sessionId, session] of sessions) {
      if (session.inFlight === 0 && session.lastUsedAt < cutoff) {
        sessions.delete(sessionId);
        closeSocketBestEffort(session);
      }
    }
    // Insertion-order eviction, skipping sessions that are mid-send.
    if (sessions.size <= maxSessions) return;
    for (const [sessionId, session] of sessions) {
      if (sessions.size <= maxSessions) break;
      if (session.inFlight > 0) continue;
      sessions.delete(sessionId);
      closeSocketBestEffort(session);
    }
  };

  return {
    getOrCreate(sessionId) {
      sweepIdle();
      const normalized = sessionId.trim();
      const existing = sessions.get(normalized);
      if (existing) {
        existing.lastUsedAt = now();
        return existing;
      }

      const created: CodexWebsocketSession = {
        sessionId: normalized,
        socket: null,
        socketUrl: null,
        queue: Promise.resolve(),
        lastUsedAt: now(),
        inFlight: 0,
      };
      sessions.set(normalized, created);
      return created;
    },
    take(sessionId) {
      sweepIdle();
      const normalized = sessionId.trim();
      if (!normalized) return null;
      const existing = sessions.get(normalized) || null;
      if (existing) {
        sessions.delete(normalized);
      }
      return existing;
    },
    list() {
      sweepIdle();
      return [...sessions.values()];
    },
  };
}
