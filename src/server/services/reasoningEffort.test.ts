import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  extractReasoningEffort,
  getCurrentReasoningEffort,
  inferReasoningEffortFromModelName,
  normalizeReasoningEffort,
  resolveRequestReasoningEffort,
  resolveWebsocketReasoningEffort,
  setCurrentReasoningEffort,
} from './reasoningEffort.js';

describe('extractReasoningEffort', () => {
  it('reads the chat/completions field', () => {
    expect(extractReasoningEffort({ model: 'gpt-5', reasoning_effort: 'high' })).toBe('high');
  });

  it('reads the responses-style nested field', () => {
    expect(extractReasoningEffort({ model: 'gpt-5', reasoning: { effort: 'low' } })).toBe('low');
  });

  it('reads the anthropic-style output_config field', () => {
    expect(extractReasoningEffort({
      model: 'claude-opus-5',
      output_config: { effort: 'medium' },
    })).toBe('medium');
  });

  it('prefers the flat field when several are present', () => {
    expect(extractReasoningEffort({
      reasoning_effort: 'medium',
      reasoning: { effort: 'high' },
      output_config: { effort: 'low' },
    })).toBe('medium');
  });

  it('falls through to output_config when reasoning is present but empty', () => {
    expect(extractReasoningEffort({
      reasoning: { summary: 'auto' },
      output_config: { effort: 'high' },
    })).toBe('high');
  });

  it('returns null when the client did not ask for an effort', () => {
    expect(extractReasoningEffort({ model: 'gpt-5' })).toBeNull();
    expect(extractReasoningEffort({ reasoning: { summary: 'auto' } })).toBeNull();
    expect(extractReasoningEffort({ reasoning_effort: '   ' })).toBeNull();
    expect(extractReasoningEffort(null)).toBeNull();
    expect(extractReasoningEffort('high')).toBeNull();
    expect(extractReasoningEffort(['high'])).toBeNull();
  });

  it('canonicalizes known spellings and keeps unknown ones verbatim', () => {
    expect(normalizeReasoningEffort('  XHIGH ')).toBe('xhigh');
    expect(normalizeReasoningEffort('extra-high')).toBe('xhigh');
    expect(normalizeReasoningEffort('Medium')).toBe('medium');
    expect(normalizeReasoningEffort('minimal')).toBe('minimal');
    // Upstreams invent values; never drop what the client sent.
    expect(normalizeReasoningEffort('crazy')).toBe('crazy');
    expect(normalizeReasoningEffort('a'.repeat(40))).toHaveLength(25); // 24 chars + ellipsis
    expect(normalizeReasoningEffort(3)).toBeNull();
  });
});

describe('inferReasoningEffortFromModelName', () => {
  it('reads an effort word that is the last model segment', () => {
    expect(inferReasoningEffortFromModelName('gpt-5-high')).toBe('high');
    expect(inferReasoningEffortFromModelName('openai/gpt-5.1-xhigh')).toBe('xhigh');
    expect(inferReasoningEffortFromModelName('glm-5.2_medium')).toBe('medium');
  });

  it('never guesses from a partial or unrelated suffix', () => {
    expect(inferReasoningEffortFromModelName('deepseek-v4-flash')).toBeNull();
    expect(inferReasoningEffortFromModelName('claude-opus-4-6-thinking')).toBeNull();
    expect(inferReasoningEffortFromModelName('gpt-5-highspeed')).toBeNull();
    expect(inferReasoningEffortFromModelName('gpt-5-high-2026')).toBeNull();
    expect(inferReasoningEffortFromModelName('')).toBeNull();
    expect(inferReasoningEffortFromModelName(null)).toBeNull();
  });
});

describe('resolveRequestReasoningEffort', () => {
  it('prefers the body field over the model name', () => {
    expect(resolveRequestReasoningEffort({ reasoning_effort: 'low' }, 'gpt-5-high')).toBe('low');
  });

  it('falls back to the model name', () => {
    expect(resolveRequestReasoningEffort({ model: 'gpt-5-high' }, 'gpt-5-high')).toBe('high');
  });

  it('returns null when neither carries an effort', () => {
    expect(resolveRequestReasoningEffort({ model: 'deepseek-flash' }, 'deepseek-flash')).toBeNull();
    expect(resolveRequestReasoningEffort(null, null)).toBeNull();
  });
});

describe('resolveWebsocketReasoningEffort', () => {
  it('prefers the current message', () => {
    expect(resolveWebsocketReasoningEffort(
      { reasoning_effort: 'low' },
      { reasoning_effort: 'high' },
      null,
    )).toBe('low');
  });

  it('inherits from the previous message when the current one omits it', () => {
    // Codex sends reasoning on the first message of a session only.
    expect(resolveWebsocketReasoningEffort(
      { type: 'response.append', input: [] },
      { type: 'response.create', reasoning: { effort: 'high' } },
      'deepseek-flash',
    )).toBe('high');
  });

  it('falls back to the model name when neither message carries one', () => {
    expect(resolveWebsocketReasoningEffort(
      { type: 'response.append' },
      { type: 'response.create' },
      'gpt-5-high',
    )).toBe('high');
  });

  it('returns null when neither carries an effort', () => {
    expect(resolveWebsocketReasoningEffort({ input: [] }, { input: [] }, 'deepseek-flash')).toBeNull();
    expect(resolveWebsocketReasoningEffort({}, null, null)).toBeNull();
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
      const body = request.body as { model?: string } | undefined;
      setCurrentReasoningEffort(resolveRequestReasoningEffort(body, body?.model));
    });
    app.post('/probe', async () => ({ effort: getCurrentReasoningEffort() }));

    try {
      const withBody = await app.inject({
        method: 'POST',
        url: '/probe',
        payload: { model: 'gpt-5', reasoning_effort: 'medium' },
      });
      expect(withBody.json()).toEqual({ effort: 'medium' });

      const withModelOnly = await app.inject({
        method: 'POST',
        url: '/probe',
        payload: { model: 'gpt-5-high' },
      });
      expect(withModelOnly.json()).toEqual({ effort: 'high' });

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
