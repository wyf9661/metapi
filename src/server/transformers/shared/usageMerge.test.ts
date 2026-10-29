import { describe, expect, it } from 'vitest';

import { mergeNormalizedUsage, createEmptyNormalizedUsage } from './normalized.js';

/**
 * Usage readings are snapshots of one request's totals, never increments. Anthropic splits
 * them across frames (input on message_start, output on message_delta) and OpenAI reports
 * once at the end; summing two readings counted the same tokens twice.
 */
describe('mergeNormalizedUsage keeps snapshot semantics', () => {
  it('takes the larger total per field instead of adding readings together', () => {
    const first = { ...createEmptyNormalizedUsage(), promptTokens: 1000, completionTokens: 0, cachedTokens: 800 };
    const second = { ...createEmptyNormalizedUsage(), promptTokens: 1000, completionTokens: 250, cachedTokens: 800 };

    const merged = mergeNormalizedUsage(first, second);
    expect(merged.promptTokens).toBe(1000); // not 2000
    expect(merged.completionTokens).toBe(250);
    expect(merged.cachedTokens).toBe(800); // not 1600
  });

  it('lets a later frame raise a field', () => {
    const merged = mergeNormalizedUsage(
      { ...createEmptyNormalizedUsage(), completionTokens: 50 },
      { ...createEmptyNormalizedUsage(), completionTokens: 320 },
    );
    expect(merged.completionTokens).toBe(320);
  });

  it('is idempotent: merging the same reading twice changes nothing', () => {
    const reading = { ...createEmptyNormalizedUsage(), promptTokens: 700, completionTokens: 90, reasoningTokens: 40 };
    const once = mergeNormalizedUsage(undefined, reading);
    const twice = mergeNormalizedUsage(once, reading);
    expect(twice).toEqual(once);
  });

  it('treats a missing side as zero without fabricating values', () => {
    const only = { ...createEmptyNormalizedUsage(), promptTokens: 12 };
    expect(mergeNormalizedUsage(undefined, only).promptTokens).toBe(12);
    expect(mergeNormalizedUsage(only, undefined).promptTokens).toBe(12);
    expect(mergeNormalizedUsage(undefined, undefined)).toEqual(createEmptyNormalizedUsage());
  });
});
