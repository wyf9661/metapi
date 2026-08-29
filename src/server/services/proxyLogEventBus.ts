import { EventEmitter } from 'node:events';

/**
 * In-process event bus for real-time proxy-log notifications.
 *
 * `insertProxyLog` emits a lightweight summary after every successful write;
 * the SSE endpoint (`/api/stats/proxy-logs/stream`) subscribes to this bus
 * and pushes the event to connected browser clients.
 *
 * The summary deliberately carries only filter-relevant fields (siteId,
 * modelRequested, status) so the client can decide whether the new log
 * matches its active filters before triggering a full reload.
 */
export type ProxyLogEvent = {
  id: number;
  siteId: number | null;
  modelRequested: string | null;
  status: string | null;
  createdAt: string | null;
};

type ProxyLogEventBusEvents = {
  'proxy-log:created': [ProxyLogEvent];
};

class ProxyLogEventBus extends EventEmitter<ProxyLogEventBusEvents> {
  constructor() {
    super();
    this.setMaxListeners(0); // unlimited SSE subscribers
  }
}

export const proxyLogEventBus = new ProxyLogEventBus();

/**
 * Emit a proxy-log-created event. Called from `insertProxyLog` after a
 * successful DB insert. Never throws — event emission is best-effort.
 */
export function emitProxyLogCreated(event: ProxyLogEvent): void {
  try {
    proxyLogEventBus.emit('proxy-log:created', event);
  } catch {
    // best-effort; never break proxy logging
  }
}
