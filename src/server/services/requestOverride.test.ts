import { describe, expect, it } from 'vitest';
import { applyRequestOverrideRules, normalizeRequestOverrideRules } from './requestOverride.js';

describe('requestOverride', () => {
  it('applies safe body operations in order', () => {
    expect(applyRequestOverrideRules({
      model: 'gpt-5',
      max_tokens: 100,
      nested: { old: true },
    }, [
      { op: 'set_if_absent', path: 'temperature', value: 0.2 },
      { op: 'set_if_absent', path: 'max_tokens', value: 999 },
      { op: 'rename', from: 'max_tokens', to: 'max_completion_tokens' },
      { op: 'copy', from: 'model', to: 'metadata.model' },
      { op: 'delete', path: 'nested.old' },
    ])).toEqual({
      model: 'gpt-5',
      nested: {},
      temperature: 0.2,
      max_completion_tokens: 100,
      metadata: { model: 'gpt-5' },
    });
  });

  it('rejects unsafe paths and malformed rules', () => {
    expect(normalizeRequestOverrideRules([
      { op: 'set', path: '__proto__.polluted', value: true },
      { op: 'set', path: 'constructor.x', value: true },
      { op: 'unknown', path: 'x', value: true },
      { op: 'set', path: 'safe', value: 1 },
    ])).toEqual([{ op: 'set', path: 'safe', value: 1 }]);
    const result = applyRequestOverrideRules({}, [{ op: 'set', path: '__proto__.polluted', value: true }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result).toEqual({});
  });
});
