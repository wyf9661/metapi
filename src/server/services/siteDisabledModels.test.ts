import { describe, expect, it } from 'vitest';
import {
  isModelDisabledForSite,
  type SiteDisabledModelsIndex,
} from './siteDisabledModels.js';

function entryFrom(models: string[]) {
  const raw = new Set<string>();
  const canonicalFree = new Set<string>();
  const canonicalNonFree = new Set<string>();
  for (const model of models) {
    const lower = model.toLowerCase();
    raw.add(lower);
    // mirror loadSiteDisabledModelsIndex canonicalization lightly for test fixtures;
    // keep :free / -free packaging state so free and non-free never collide.
    const slash = lower.split('/').filter(Boolean);
    const base = slash.length > 1 ? slash[slash.length - 1]! : lower;
    const free = /:free$/i.test(model) || /-free$/i.test(model);
    const canonical = base.replace(/:free$/i, '').replace(/-free$/i, '');
    if (canonical) {
      (free ? canonicalFree : canonicalNonFree).add(canonical);
    }
  }
  return { raw, canonicalFree, canonicalNonFree };
}

function indexFrom(entries: Array<[number, string[]]>): SiteDisabledModelsIndex {
  const index: SiteDisabledModelsIndex = new Map();
  for (const [siteId, models] of entries) {
    index.set(siteId, { ...entryFrom(models), byAccount: new Map() });
  }
  return index;
}

/** Site-wide rows plus per-account rows, as the loader builds them. */
function indexWithAccounts(
  siteId: number,
  siteWide: string[],
  perAccount: Array<[number, string[]]> = [],
): SiteDisabledModelsIndex {
  const byAccount = new Map<number, ReturnType<typeof entryFrom>>();
  for (const [accountId, models] of perAccount) {
    byAccount.set(accountId, entryFrom(models));
  }
  return new Map([[siteId, { ...entryFrom(siteWide), byAccount }]]);
}

describe('isModelDisabledForSite', () => {
  it('matches exact raw names case-insensitively', () => {
    const index = indexFrom([[1, ['gpt-4o']]]);
    expect(isModelDisabledForSite(index, 1, 'GPT-4o')).toBe(true);
    expect(isModelDisabledForSite(index, 1, 'gpt-4o-mini')).toBe(false);
    expect(isModelDisabledForSite(index, 2, 'gpt-4o')).toBe(false);
  });

  it('matches provider-prefixed aliases via canonical name (same free-ness)', () => {
    const index = indexFrom([[88, ['qwen/qwen3.8-max-preview']]]);
    expect(isModelDisabledForSite(index, 88, 'qwen3.8-max-preview')).toBe(true);
    expect(isModelDisabledForSite(index, 88, 'QWEN/qwen3.8-max-preview')).toBe(true);
  });

  it('disabling free only blocks same free variant, not its non-free sibling', () => {
    const index = indexFrom([[88, ['qwen/qwen3.8-max-preview:free']]]);
    expect(isModelDisabledForSite(index, 88, 'qwen3.8-max-preview:free')).toBe(true);
    expect(isModelDisabledForSite(index, 88, 'qwen/qwen3.8-max-preview')).toBe(false);
  });

  it('disabling non-free only blocks same non-free variant, not its free sibling', () => {
    const index = indexFrom([[88, ['qwen3.8-max-preview']]]);
    expect(isModelDisabledForSite(index, 88, 'qwen3.8-max-preview')).toBe(true);
    expect(isModelDisabledForSite(index, 88, 'qwen/qwen3.8-max-preview:free')).toBe(false);
  });

  it('applies to -free suffix (not just :free)', () => {
    const index = indexFrom([[88, ['deepseek/deepseek-v4-flash']]]);
    expect(isModelDisabledForSite(index, 88, 'deepseek/deepseek-v4-flash')).toBe(true);
    // non-free disable must not block the -free variant
    expect(isModelDisabledForSite(index, 88, 'deepseek/deepseek-v4-flash-free')).toBe(false);
  });

  it('raw name match still blocks exact -free variant regardless of canonical sets', () => {
    const index = indexFrom([[88, ['deepseek/deepseek-v4-flash-free']]]);
    expect(isModelDisabledForSite(index, 88, 'deepseek/deepseek-v4-flash-free')).toBe(true);
    // free disable blocks free exact name but not non-free sibling
    expect(isModelDisabledForSite(index, 88, 'deepseek/deepseek-v4-flash')).toBe(false);
  });

  it('keeps per-key rows isolated to the key they belong to', () => {
    const index = indexWithAccounts(283, [], [[291, ['gpt-5.4']], [292, ['kimi-k2.6']]]);
    // Key 291 disables gpt-5.4 and nothing else.
    expect(isModelDisabledForSite(index, 283, 'gpt-5.4', 291)).toBe(true);
    expect(isModelDisabledForSite(index, 283, 'kimi-k2.6', 291)).toBe(false);
    // Key 292 is the mirror image: same site, independent set.
    expect(isModelDisabledForSite(index, 283, 'kimi-k2.6', 292)).toBe(true);
    expect(isModelDisabledForSite(index, 283, 'gpt-5.4', 292)).toBe(false);
    // Without an account context only site-wide rows are visible.
    expect(isModelDisabledForSite(index, 283, 'gpt-5.4')).toBe(false);
    expect(isModelDisabledForSite(index, 283, 'kimi-k2.6')).toBe(false);
  });

  it('applies site-wide rows to every key alongside its own rows', () => {
    const index = indexWithAccounts(283, ['glm-5.2'], [[291, ['gpt-5.4']]]);
    // Site-wide applies to both keys.
    expect(isModelDisabledForSite(index, 283, 'glm-5.2', 291)).toBe(true);
    expect(isModelDisabledForSite(index, 283, 'glm-5.2', 292)).toBe(true);
    expect(isModelDisabledForSite(index, 283, 'glm-5.2')).toBe(true);
    // Per-key applies only to its own key.
    expect(isModelDisabledForSite(index, 283, 'gpt-5.4', 291)).toBe(true);
    expect(isModelDisabledForSite(index, 283, 'gpt-5.4', 292)).toBe(false);
  });

  it('honours the free/non-free split inside a per-key set', () => {
    const index = indexWithAccounts(283, [], [[291, ['deepseek/deepseek-v4-flash:free']]]);
    expect(isModelDisabledForSite(index, 283, 'deepseek-v4-flash:free', 291)).toBe(true);
    expect(isModelDisabledForSite(index, 283, 'deepseek-v4-flash', 291)).toBe(false);
  });
});