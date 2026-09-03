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

/**
 * Channel failover is only safe before the downstream response is committed.
 * After reply.hijack() + SSE headers (or any body bytes), retrying another
 * channel re-enters startSseResponse and throws:
 * "Cannot set headers after they are sent to the client".
 */
export function canFailoverToNextChannel(reply: FastifyReply): boolean {
  return !isFastifyReplyCommitted(reply);
}

/**
 * True when the downstream client connection is already gone (aborted /
 * closed before a normal response end). An empty / zero-usage upstream
 * outcome in this state is the client cancel itself, not an upstream
 * defect: it must not be treated as an upstream empty-content failure
 * (which would failover and record a channel failure that degrades the
 * routing health of a perfectly healthy channel).
 */
export function isDownstreamReplyGone(reply: FastifyReply): boolean {
  const raw = (reply?.raw ?? undefined) as
    | { destroyed?: boolean; aborted?: boolean; writableEnded?: boolean; socket?: { destroyed?: boolean } | null }
    | undefined;
  if (!raw) return false;
  if (raw.destroyed === true || raw.aborted === true) return true;
  // A client abort tears down the underlying socket before the response
  // finishes normally (writableEnded stays false).
  if (raw.writableEnded !== true && raw.socket?.destroyed === true) return true;
  return false;
}

/**
 * True when the error represents a downstream client disconnect, not an
 * upstream server failure. These should not be logged as HTTP 500 or
 * trigger alert noise — the client simply went away (closed tab, network
 * switch, page navigation).
 */
export function isClientDisconnectError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  return (
    code === 'ERR_STREAM_PREMATURE_CLOSE'
    || code === 'ABORT_ERR'
    || /premature close|client disconnected|aborted/i.test(message)
  );
}
