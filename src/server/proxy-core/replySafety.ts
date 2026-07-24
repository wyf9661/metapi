import type { FastifyReply } from 'fastify';

/**
 * True when headers/body may already be on the wire (including after reply.hijack()).
 * After this, reply.code().send() throws FST_ERR_REP_ALREADY_SENT or
 * "Cannot set headers after they are sent to the client".
 */
export function isFastifyReplyCommitted(reply: FastifyReply): boolean {
  try {
    if (reply.sent) return true;
  } catch {
    // ignore
  }
  const raw = reply.raw as { headersSent?: boolean; writableEnded?: boolean } | undefined;
  if (!raw) return false;
  return !!(raw.headersSent || raw.writableEnded);
}

/**
 * Send a JSON (or any) HTTP error/success only when the reply is still writable.
 * Returns true if the body was handed to Fastify; false if the response was already committed.
 */
export function sendReplyIfWritable(
  reply: FastifyReply,
  statusCode: number,
  payload: unknown,
): boolean {
  if (isFastifyReplyCommitted(reply)) {
    console.warn(
      `[proxy] skip reply.code(${statusCode}).send: response already committed (hijacked/streamed)`,
    );
    return false;
  }
  reply.code(statusCode).send(payload);
  return true;
}

/** Best-effort end a hijacked raw stream without throwing. */
export function endRawReplyQuietly(reply: FastifyReply): void {
  try {
    const raw = reply.raw as { writableEnded?: boolean; destroyed?: boolean; end?: () => void };
    if (!raw || raw.writableEnded || raw.destroyed) return;
    raw.end?.();
  } catch {
    // ignore
  }
}
