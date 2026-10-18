import { randomUUID } from 'node:crypto';

/**
 * Per-process secret that proves an HTTP request was injected internally by
 * the responses websocket transport route. The transport marker header alone
 * is client-writable, so it must never be trusted on its own: a downstream
 * caller could otherwise skip the responses pre-flight validation and force
 * whole-stream buffering (defeating streaming and burning memory).
 */
export const INTERNAL_TRANSPORT_NONCE = randomUUID();

export const INTERNAL_TRANSPORT_NONCE_HEADER = 'x-metapi-internal-nonce';
