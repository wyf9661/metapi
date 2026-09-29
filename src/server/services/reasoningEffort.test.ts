import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  downgradeReasoningEffortInBody,
  extractReasoningEffort,
  getCurrentReasoningEffort,
  inferReasoningEffortFromModelName,
  isNoneReasoningEffortRejection,
  isReasoningEffortRejection,
  normalizeReasoningEffort,
  resolveRequestReasoningEffort,
  resolveWebsocketReasoningEffort,
  setCurrentReasoningEffort,
  stripReasoningEffortFromBody,
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

describe('isReasoningEffortRejection', () => {
  it('recognises the responses-side ladder message', () => {
    expect(isReasoningEffortRejection(
      'Upstream returned HTTP 400: level "max" not supported, valid levels: low, medium, high',
    )).toBe(true);
  });

  it('recognises the chat-side field message', () => {
    expect(isReasoningEffortRejection(
      'Upstream returned HTTP 400: field ReasoningEffort invalid, should be one of: low, medium, high, xhigh, none',
    )).toBe(true);
  });

  it('ignores unrelated body errors and empty text', () => {
    expect(isReasoningEffortRejection('Upstream returned HTTP 400: invalid request body')).toBe(false);
    expect(isReasoningEffortRejection('Upstream returned HTTP 400: credit insufficient balance: balance=0')).toBe(false);
    expect(isReasoningEffortRejection('')).toBe(false);
    expect(isReasoningEffortRejection(null)).toBe(false);
  });

  it('matches reasoning effort references with space or hyphen variants', () => {
    expect(isReasoningEffortRejection('reasoning effort value rejected')).toBe(true);
    expect(isReasoningEffortRejection('reasoning-effort is unsupported')).toBe(true);
  });
});

describe('isNoneReasoningEffortRejection', () => {
  it('matches the model-specific `none` rejection', () => {
    expect(isNoneReasoningEffortRejection(
      'Upstream returned HTTP 400: This model does not support `reasoning_effort` value `none`.',
    )).toBe(true);
  });

  it('does not match ladder rejections or unrelated text', () => {
    expect(isNoneReasoningEffortRejection(
      'level "max" not supported, valid levels: low, medium, high',
    )).toBe(false);
    expect(isNoneReasoningEffortRejection('invalid request body')).toBe(false);
  });
});

describe('stripReasoningEffortFromBody', () => {
  it('removes the flat chat/completions field', () => {
    const body: Record<string, unknown> = { model: 'grok-4.7', reasoning_effort: 'none', temperature: 0.2 };
    expect(stripReasoningEffortFromBody(body)).toBe(true);
    expect(body).toEqual({ model: 'grok-4.7', temperature: 0.2 });
  });

  it('removes nested responses and anthropic slots and drops emptied containers', () => {
    const responsesBody: Record<string, unknown> = { model: 'grok-4.7', reasoning: { effort: 'none' } };
    expect(stripReasoningEffortFromBody(responsesBody)).toBe(true);
    expect(responsesBody).toEqual({ model: 'grok-4.7' });

    const anthropicBody: Record<string, unknown> = { model: 'claude-opus-5', output_config: { effort: 'none' } };
    expect(stripReasoningEffortFromBody(anthropicBody)).toBe(true);
    expect(anthropicBody).toEqual({ model: 'claude-opus-5' });
  });

  it('keeps a nested container that still has other keys', () => {
    const body: Record<string, unknown> = { model: 'grok-4.7', reasoning: { effort: 'none', summary: 'auto' } };
    expect(stripReasoningEffortFromBody(body)).toBe(true);
    expect(body).toEqual({ model: 'grok-4.7', reasoning: { summary: 'auto' } });
  });

  it('returns false when there is nothing to strip', () => {
    const body: Record<string, unknown> = { model: 'gpt-5', temperature: 0.2 };
    expect(stripReasoningEffortFromBody(body)).toBe(false);
    expect(body).toEqual({ model: 'gpt-5', temperature: 0.2 });
    expect(stripReasoningEffortFromBody(null)).toBe(false);
    expect(stripReasoningEffortFromBody(undefined)).toBe(false);
  });
});

describe('downgradeReasoningEffortInBody', () => {
  it('steps the flat chat field down one rung', () => {
    const body: Record<string, unknown> = { model: 'gpt-5', reasoning_effort: 'max' };

    expect(downgradeReasoningEffortInBody(body)).toBe('xhigh');
    expect(body.reasoning_effort).toBe('xhigh');

    expect(downgradeReasoningEffortInBody(body)).toBe('high');
    expect(body.reasoning_effort).toBe('high');
  });

  it('steps the nested responses and anthropic shapes', () => {
    const responsesBody: Record<string, unknown> = { reasoning: { effort: 'xhigh' } };
    expect(downgradeReasoningEffortInBody(responsesBody)).toBe('high');
    expect(responsesBody.reasoning).toEqual({ effort: 'high' });

    const anthropicBody: Record<string, unknown> = { output_config: { effort: 'MAX' } };
    expect(downgradeReasoningEffortInBody(anthropicBody)).toBe('xhigh');
    expect(anthropicBody.output_config).toEqual({ effort: 'xhigh' });
  });

  it('keeps stepping down the ladder until it reaches the floor', () => {
    const body: Record<string, unknown> = { reasoning_effort: 'high' };

    expect(downgradeReasoningEffortInBody(body)).toBe('medium');
    expect(downgradeReasoningEffortInBody(body)).toBe('low');
    expect(downgradeReasoningEffortInBody(body)).toBe('minimal');
    // `minimal` is the floor: nothing left to trade away.
    expect(downgradeReasoningEffortInBody(body)).toBeNull();
    expect(body.reasoning_effort).toBe('minimal');
  });

  it('leaves bodies without an effort untouched', () => {
    const body: Record<string, unknown> = { model: 'gpt-5', temperature: 0.2 };
    expect(downgradeReasoningEffortInBody(body)).toBeNull();
    expect(body).toEqual({ model: 'gpt-5', temperature: 0.2 });
    expect(downgradeReasoningEffortInBody(null)).toBeNull();
    expect(downgradeReasoningEffortInBody(undefined)).toBeNull();
  });
});
