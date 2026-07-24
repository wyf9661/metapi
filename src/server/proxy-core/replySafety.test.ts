import { describe, expect, it, vi } from 'vitest';
import { isFastifyReplyCommitted, sendReplyIfWritable, endRawReplyQuietly } from './replySafety.js';

function makeReply(opts: { sent?: boolean; raw?: Record<string, unknown> } = {}) {
  const reply = {
    sent: opts.sent ?? false,
    code: vi.fn().mockReturnThis(),
    send: vi.fn(),
    type: vi.fn().mockReturnThis(),
    raw: { headersSent: false, writableEnded: false, ...opts.raw },
  };
  return reply as any;
}

describe('replySafety', () => {
  it('returns false for a fresh reply', () => {
    expect(isFastifyReplyCommitted(makeReply())).toBe(false);
  });

  it('returns true when reply.sent is true', () => {
    expect(isFastifyReplyCommitted(makeReply({ sent: true }))).toBe(true);
  });

  it('returns true when raw.headersSent is true', () => {
    expect(isFastifyReplyCommitted(makeReply({ raw: { headersSent: true } }))).toBe(true);
  });

  it('returns true when raw.writableEnded is true', () => {
    expect(isFastifyReplyCommitted(makeReply({ raw: { writableEnded: true } }))).toBe(true);
  });

  it('sendReplyIfWritable sends when reply is fresh', () => {
    const reply = makeReply();
    const ok = sendReplyIfWritable(reply, 400, { error: 'test' });
    expect(ok).toBe(true);
    expect(reply.code).toHaveBeenCalledWith(400);
  });

  it('sendReplyIfWritable skips when already committed', () => {
    const reply = makeReply({ sent: true });
    const ok = sendReplyIfWritable(reply, 400, { error: 'test' });
    expect(ok).toBe(false);
  });

  it('endRawReplyQuietly is a no-op on a fresh reply', () => {
    endRawReplyQuietly(makeReply());
  });

  it('endRawReplyQuietly does not throw when raw.end is not a function', () => {
    endRawReplyQuietly(makeReply({ raw: { headersSent: true } }));
  });

  it('endRawReplyQuietly calls raw.end when writable', () => {
    const endFn = vi.fn();
    const reply = makeReply({ raw: { headersSent: true, end: endFn } });
    endRawReplyQuietly(reply);
    expect(endFn).toHaveBeenCalled();
  });
});
