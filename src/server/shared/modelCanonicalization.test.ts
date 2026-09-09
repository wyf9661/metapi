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

    expect(canonicalizeModelName('DeepSeek-V4-Pro')).toBe('deepseek-v4-pro');
    expect(canonicalizeModelName('deepseek-ai/deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(canonicalizeModelName('deepseek-v4-pro-fast')).toBe('deepseek-v4-pro-fast');
    expect(canonicalizeModelName('deepseek-v4-pro-think')).toBe('deepseek-v4-pro-think');
  });

  it('strips date suffixes so snapshots share the base model key', () => {
    expect(canonicalizeModelName('deepseek-v4-flash-0731')).toBe('deepseek-v4-flash');
    expect(canonicalizeModelName('deepseek-v4-flash-20260731')).toBe('deepseek-v4-flash');
    expect(canonicalizeModelName('deepseek-v4-flash-260731')).toBe('deepseek-v4-flash');
    expect(canonicalizeModelName('deepseek-ai/deepseek-v4-flash-0731')).toBe('deepseek-v4-flash');
    expect(canonicalizeModelName('deepseek-v4-pro-0813')).toBe('deepseek-v4-pro');
    expect(canonicalizeModelName('deepseek-v4-pro-20260731')).toBe('deepseek-v4-pro');
    expect(canonicalizeModelName('glm-5.2-0715')).toBe('glm-5.2');
  });

  it('keeps ollama owner namespaces intact but still merges relay prefixes', () => {
    // owner/model:tag — the owner is part of the model identity, keep it.
    expect(canonicalizeModelName('linux6200/bge-reranker-v2-m3:latest')).toBe('linux6200/bge-reranker-v2-m3:latest');
    expect(canonicalizeModelName('quentinz/bge-large-zh-v1.5:latest')).toBe('quentinz/bge-large-zh-v1.5:latest');
    expect(canonicalizeModelName('Quentinz/Bge-Large-Zh-V1.5:Latest')).toBe('quentinz/bge-large-zh-v1.5:latest');
    // A bare relay prefix (no tag) still merges to the base model.
    expect(canonicalizeModelName('z-ai/glm-5.2')).toBe('glm-5.2');
    expect(canonicalizeModelName('deepseek-ai/deepseek-v4-flash')).toBe('deepseek-v4-flash');
    // A relay prefix plus a packaging free label still merges.
    expect(canonicalizeModelName('z-ai/glm-5.2:free')).toBe('glm-5.2');
  });

  it('keeps non-date numeric suffixes and true variants intact', () => {
    // 1m / 262k are context-window variants, not dates.
    expect(canonicalizeModelName('glm-5.2-1m')).toBe('glm-5.2-1m');
    expect(canonicalizeModelName('glm-5.2-262k')).toBe('glm-5.2-262k');
    expect(canonicalizeModelName('deepseek-v4-flash-fast')).toBe('deepseek-v4-flash-fast');
    // Full ISO date ends in 2-digit day; must not be stripped.
    expect(canonicalizeModelName('gpt-4o-2024-05-13')).toBe('gpt-4o-2024-05-13');
    // Official snapshot names of other families must stay intact.
    expect(canonicalizeModelName('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
  });
});
