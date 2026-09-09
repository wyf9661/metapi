import { describe, expect, it } from 'vitest';
import { canonicalizeModelName } from './modelCanonicalization.js';

describe('model canonicalization', () => {
  it('groups provider prefixes and case-only variants for selected model families', () => {
    expect(canonicalizeModelName('MiniMax-M2.7')).toBe('minimax-m2.7');
    expect(canonicalizeModelName('minimax/minimax-m2.7')).toBe('minimax-m2.7');
    expect(canonicalizeModelName('minimaxai/minimax-m2.7')).toBe('minimax-m2.7');

    expect(canonicalizeModelName('GLM-5.2')).toBe('glm-5.2');
    expect(canonicalizeModelName('z-ai/glm-5.2')).toBe('glm-5.2');
    expect(canonicalizeModelName('GLM-5.2-1M')).toBe('glm-5.2');
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

  it('strips stacked decorations iteratively for known families', () => {
    // Channel-ordinal free label after a date snapshot (WeChat 2026-09-09
    // case): deepseek-v4-flash-0731-free-3 used to fail every anchored strip.
    expect(canonicalizeModelName('deepseek-v4-flash-0731-free-3')).toBe('deepseek-v4-flash');
    expect(canonicalizeModelName('DeepSeek-V4-Flash-0731-free-3')).toBe('deepseek-v4-flash');
    expect(canonicalizeModelName('deepseek-v4-flash-free-3')).toBe('deepseek-v4-flash');
    // Date snapshot before a true variant must merge to the variant, not stay
    // as a separate model (0731 ≡ base, therefore 0731-think ≡ think).
    expect(canonicalizeModelName('DeepSeek-V4-Flash-0731-think')).toBe('deepseek-v4-flash-think');
    expect(canonicalizeModelName('DeepSeek-V4-Pro-0813-think')).toBe('deepseek-v4-pro-think');
    expect(canonicalizeModelName('deepseek-v4-flash-20260731-free-3')).toBe('deepseek-v4-flash');
    // Context-window variant behind a snapshot — the snapshot AND the
    // 1m/262k window label both strip, the think variant stays.
    expect(canonicalizeModelName('glm-5.2-0715-1m')).toBe('glm-5.2');
    expect(canonicalizeModelName('glm-5.2-0715-think')).toBe('glm-5.2-think');
  });

  it('keeps highspeed and other real variants intact for minimax and friends', () => {
    // highspeed is a true capability tier, never a decoration.
    expect(canonicalizeModelName('MiniMax-M3-highspeed')).toBe('minimax-m3-highspeed');
    expect(canonicalizeModelName('MiniMax-M3-highspeed-think')).toBe('minimax-m3-highspeed-think');
    expect(canonicalizeModelName('MiniMax-M2.7-highspeed')).toBe('minimax-m2.7-highspeed');
    // A date snapshot in front of a highspeed variant still merges to the
    // variant once such names appear.
    expect(canonicalizeModelName('MiniMax-M3-0813-highspeed-think')).toBe('minimax-m3-highspeed-think');
    expect(canonicalizeModelName('MiniMax-M3-0813-highspeed')).toBe('minimax-m3-highspeed');
    // Non-dated family names keep their variant suffix.
    expect(canonicalizeModelName('GLM-5.2-fast-preview')).toBe('glm-5.2-fast-preview');
  });

  it('strips context-window labels (1m/262k) but keeps action variants', () => {
    // 1m/262k are unreliable packaging labels (channels claiming the window
    // are not guaranteed to serve it; clients never request these names), so
    // they merge to the base model...
    expect(canonicalizeModelName('glm-5.2-1m')).toBe('glm-5.2');
    expect(canonicalizeModelName('glm-5.2-262k')).toBe('glm-5.2');
    expect(canonicalizeModelName('GLM-5.3-1M')).toBe('glm-5.3');
    // ...including when they sit between the base and a kept action variant.
    expect(canonicalizeModelName('glm-5.2-1m-think')).toBe('glm-5.2-think');
    expect(canonicalizeModelName('glm-5.2-262k-think')).toBe('glm-5.2-think');
    // Action variants themselves are never stripped.
    expect(canonicalizeModelName('deepseek-v4-flash-fast')).toBe('deepseek-v4-flash-fast');
    // Full ISO date ends in 2-digit day; must not be stripped.
    expect(canonicalizeModelName('gpt-4o-2024-05-13')).toBe('gpt-4o-2024-05-13');
    // Official snapshot names of other families must stay intact.
    expect(canonicalizeModelName('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
  });
});
