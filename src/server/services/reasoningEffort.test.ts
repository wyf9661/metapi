import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  extractReasoningEffort,
  getCurrentReasoningEffort,
  normalizeReasoningEffort,
  setCurrentReasoningEffort,
} from './reasoningEffort.js';

describe('extractReasoningEffort', () => {
  it('reads the chat/completions field', () => {
    expect(extractReasoningEffort({ model: 'gpt-5', reasoning_effort: 'high' })).toBe('high');
  });

  it('reads the responses-style nested field', () => {
    expect(extractReasoningEffort({ model: 'gpt-5', reasoning: { effort: 'low' } })).toBe('low');
  });

  it('prefers the flat field when both are present', () => {
    expect(extractReasoningEffort({
      reasoning_effort: 'medium',
      reasoning: { effort: 'high' },
    })).toBe('medium');
  });

  it('returns null when the client did not ask for an effort', () => {
    expect(extractReasoningEffort({ model: 'gpt-5' })).toBeNull();
    expect(extractReasoningEffort({ reasoning: { summary: 'auto' } })).toBeNull();
    expect(extractReasoningEffort({ reasoning_effort: '   ' })).toBeNull();
    expect(extractReasoningEffort(null)).toBeNull();
    expect(extractReasoningEffort('high')).toBeNull();
    expect(extractReasoningEffort(['high'])).toBeNull();
  });

  it('keeps unknown effort names verbatim but bounded', () => {
    expect(normalizeReasoningEffort('  xhigh ')).toBe('xhigh');
    expect(normalizeReasoningEffort('a'.repeat(40))).toHaveLength(25); // 24 chars + ellipsis
    expect(normalizeReasoningEffort(3)).toBeNull();
  });
});

describe('request-scoped reasoning effort', () => {
  it('survives awaits in the same async context', async () => {
    setCurrentReasoningEffort('high');
    await Promise.resolve();
    expect(getCurrentReasoningEffort()).toBe('high');
    setCurrentReasoningEffort(null);
    expect(getCurrentReasoningEffort()).toBeNull();
  });

  it('propagates from a proxy-router style hook into the handler', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      setCurrentReasoningEffort(extractReasoningEffort(request.body));
    });
    app.post('/probe', async () => ({ effort: getCurrentReasoningEffort() }));

    try {
      const withEffort = await app.inject({
        method: 'POST',
        url: '/probe',
        payload: { model: 'gpt-5', reasoning_effort: 'medium' },
      });
      expect(withEffort.json()).toEqual({ effort: 'medium' });

      const withoutEffort = await app.inject({
        method: 'POST',
        url: '/probe',
        payload: { model: 'gpt-5' },
      });
      // A later request must not inherit the previous request's value.
      expect(withoutEffort.json()).toEqual({ effort: null });
    } finally {
      await app.close();
    }
  });
});
