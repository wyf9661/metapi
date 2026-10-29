import { describe, expect, it } from 'vitest';

import { parseToolUseInput } from './toolUseInput.js';

describe('parseToolUseInput', () => {
  it('parses valid argument JSON unchanged', () => {
    expect(parseToolUseInput('{"path":"/tmp/x","n":2}')).toEqual({ path: '/tmp/x', n: 2 });
  });

  it('repairs a truncated object instead of reporting a bogus value parameter', () => {
    // Regression: this used to become { value: '{"path":"/tmp/x' } so the tool ran with no
    // arguments at all and reported success.
    expect(parseToolUseInput('{"path":"/tmp/x')).toEqual({ path: '/tmp/x' });
    expect(parseToolUseInput('{"a":{"b":[1,2')).toEqual({ a: { b: [1, 2] } });
  });

  it('falls back to an empty object when the text cannot be repaired', () => {
    expect(parseToolUseInput('not json at all')).toEqual({});
    expect(parseToolUseInput('')).toEqual({});
    expect(parseToolUseInput('[1,2,3]')).toEqual({});
  });
});
