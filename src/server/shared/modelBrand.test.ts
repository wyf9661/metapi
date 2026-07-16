import { describe, expect, it } from 'vitest';
import { getBrand, getMatchingBrandNames } from './modelBrand.js';

describe('modelBrand matching helpers', () => {
  it('returns all matched provider and vendor brands while preserving display priority', () => {
    expect(getMatchingBrandNames('openrouter/anthropic/claude-3-7-sonnet')).toEqual(['Anthropic', 'OpenRouter']);
    expect(getMatchingBrandNames('deepinfra/meta-llama/llama-3.3-70b-instruct')).toEqual(['Meta', 'DeepInfra']);
    expect(getMatchingBrandNames('azureai/gpt-4o')).toEqual(['OpenAI', 'Azure AI']);
    expect(getMatchingBrandNames('bedrock/us.amazon.nova-pro-v1:0')).toEqual(['Amazon Nova', 'AWS Bedrock']);

    expect(getBrand('openrouter/anthropic/claude-3-7-sonnet')?.name).toBe('Anthropic');
    expect(getBrand('deepinfra/meta-llama/llama-3.3-70b-instruct')?.name).toBe('Meta');
  });

  it('classifies custom marketplace model brands', () => {
    expect(getBrand('agnes-2.0-flash')?.name).toBe('Agnes');
    expect(getBrand('hy-mt2:7b')?.name).toBe('腾讯混元');
    expect(getBrand('hy3')?.name).toBe('腾讯混元');
    expect(getBrand('big-pickle')?.name).toBe('OpenCode');
    expect(getBrand('north-mini-code-free')?.name).toBe('OpenCode');
    expect(getBrand('poolside/laguna-xs.2:free')?.name).toBe('OpenCode');
    expect(getBrand('kilo-auto')?.name).toBe('Kilo');
    expect(getBrand('codex-auto-review')?.name).toBe('OpenAI');
  });
});
