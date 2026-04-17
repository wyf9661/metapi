import { describe, expect, it } from 'vitest';
import { normalizeCodexResponsesBodyForProxy } from './codexCompatibility.js';

const CODEX_DEFAULT_INSTRUCTIONS = 'You are a helpful coding assistant.';

describe('normalizeCodexResponsesBodyForProxy', () => {
  it('extracts codex system input into top-level instructions before proxying upstream', () => {
    const body = normalizeCodexResponsesBodyForProxy({
      input: [
        {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: 'be precise' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      ],
      instructions: 'keep edits narrow',
      max_output_tokens: 512,
      max_completion_tokens: 256,
      max_tokens: 128,
      temperature: 0.3,
      store: true,
    }, 'codex');

    expect(body).toEqual({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      ],
      instructions: 'be precise\n\nkeep edits narrow',
      store: false,
      temperature: 0.3,
    });
  });

  it('supplies a non-empty default instructions string for codex when missing', () => {
    const body = normalizeCodexResponsesBodyForProxy({
      input: 'hello',
    }, 'codex');

    expect(body).toEqual({
      input: 'hello',
      instructions: CODEX_DEFAULT_INSTRUCTIONS,
      store: false,
    });
  });

  it('leaves non-codex bodies untouched', () => {
    const source = {
      input: 'hello',
      max_output_tokens: 512,
    };

    const body = normalizeCodexResponsesBodyForProxy(source, 'openai');

    expect(body).toBe(source);
  });
});
