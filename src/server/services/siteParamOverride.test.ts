import { describe, expect, it } from 'vitest';
import {
  mergeParamOverrideIntoBody,
  parseSiteParamOverrideInput,
} from './siteParamOverride.js';

describe('parseSiteParamOverrideInput', () => {
  it('accepts null / undefined / empty as "no override"', () => {
    expect(parseSiteParamOverrideInput(undefined)).toEqual({ valid: true, paramOverride: null });
    expect(parseSiteParamOverrideInput(null)).toEqual({ valid: true, paramOverride: null });
    expect(parseSiteParamOverrideInput('')).toEqual({ valid: true, paramOverride: null });
  });

  it('accepts a valid JSON object string', () => {
    const result = parseSiteParamOverrideInput('{"max_tokens": 64, "temperature": 0}');
    expect(result.valid).toBe(true);
    expect(result).toEqual({ valid: true, paramOverride: '{"max_tokens": 64, "temperature": 0}' });
  });

  it('rejects non-string input', () => {
    expect(parseSiteParamOverrideInput(123).valid).toBe(false);
    expect(parseSiteParamOverrideInput({ a: 1 }).valid).toBe(false);
  });

  it('rejects invalid JSON', () => {
    expect(parseSiteParamOverrideInput('{not json}').valid).toBe(false);
  });

  it('rejects JSON arrays and scalars', () => {
    expect(parseSiteParamOverrideInput('[1,2]').valid).toBe(false);
    expect(parseSiteParamOverrideInput('"hi"').valid).toBe(false);
    expect(parseSiteParamOverrideInput('42').valid).toBe(false);
  });

  it('rejects oversized input', () => {
    const big = `{"x": "${'a'.repeat(5000)}"}`;
    expect(parseSiteParamOverrideInput(big).valid).toBe(false);
  });
});

describe('mergeParamOverrideIntoBody', () => {
  it('returns the body untouched when there is no override', () => {
    const body = { model: 'gpt-4o', max_tokens: 100 };
    expect(mergeParamOverrideIntoBody(body, null)).toBe(body);
    expect(mergeParamOverrideIntoBody(body, undefined)).toBe(body);
    expect(mergeParamOverrideIntoBody(body, '')).toBe(body);
  });

  it('merges top-level keys with override winning', () => {
    const body = { model: 'gpt-4o', max_tokens: 100, stream: false };
    const merged = mergeParamOverrideIntoBody(body, '{"max_tokens": 64, "stream": true}');
    expect(merged).toEqual({ model: 'gpt-4o', max_tokens: 64, stream: true });
    expect(body).toEqual({ model: 'gpt-4o', max_tokens: 100, stream: false }); // no mutation
  });

  it('replaces nested objects wholesale (no deep merge)', () => {
    const body = { tools: { a: 1 }, reasoning: { effort: 'low' } };
    const merged = mergeParamOverrideIntoBody(body, '{"reasoning": {"effort": "high"}}');
    expect(merged.reasoning).toEqual({ effort: 'high' });
  });

  it('returns the body unchanged for invalid override JSON', () => {
    const body = { model: 'gpt-4o' };
    expect(mergeParamOverrideIntoBody(body, '{broken')).toBe(body);
    expect(mergeParamOverrideIntoBody(body, '[1,2]')).toBe(body);
  });
});
