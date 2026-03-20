import type WebSocket from 'ws';

export type CodexWebsocketRuntimeSendInput = {
  sessionId: string;
  requestUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type CodexWebsocketRuntimeResult = {
  events: Array<Record<string, unknown>>;
  reusedSession: boolean;
};

export type CodexWebsocketSession = {
  sessionId: string;
  socket: WebSocket | null;
  socketUrl: string | null;
  queue: Promise<unknown>;
};

export type CodexWebsocketSessionStore = {
  getOrCreate(sessionId: string): CodexWebsocketSession;
  take(sessionId: string): CodexWebsocketSession | null;
  list(): CodexWebsocketSession[];
};
