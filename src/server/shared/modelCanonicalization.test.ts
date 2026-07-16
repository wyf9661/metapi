import { describe, expect, it } from 'vitest';
import { canonicalizeModelName } from './modelCanonicalization.js';

describe('model canonicalization', () => {
  it('groups provider prefixes and case-only variants for selected model families', () => {
    expect(canonicalizeModelName('MiniMax-M2.7')).toBe('minimax-m2.7');
    expect(canonicalizeModelName('minimax/minimax-m2.7')).toBe('minimax-m2.7');
    expect(canonicalizeModelName('minimaxai/minimax-m2.7')).toBe('minimax-m2.7');

    expect(canonicalizeModelName('GLM-5.2')).toBe('glm-5.2');
    expect(canonicalizeModelName('z-ai/glm-5.2')).toBe('glm-5.2');
    expect(canonicalizeModelName('GLM-5.2-1M')).toBe('glm-5.2-1m');
    expect(canonicalizeModelName('GLM-5.2-think')).toBe('glm-5.2-think');

    expect(canonicalizeModelName('DeepSeek-V4-Flash')).toBe('deepseek-v4-flash');
    expect(canonicalizeModelName('deepseek-ai/deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(canonicalizeModelName('deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(canonicalizeModelName('deepseek-v4-flash-free')).toBe('deepseek-v4-flash');
    expect(canonicalizeModelName('deepseek-v4-flash:free')).toBe('deepseek-v4-flash');
    expect(canonicalizeModelName('DeepSeek-V4-Flash-fast')).toBe('deepseek-v4-flash-fast');
    expect(canonicalizeModelName('DeepSeek-V4-Flash-think')).toBe('deepseek-v4-flash-think');
  });
});
