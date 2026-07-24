import { describe, expect, it } from 'vitest';
import {
  isModelDisabledForSite,
  type SiteDisabledModelsIndex,
} from './siteDisabledModels.js';

function indexFrom(entries: Array<[number, string[]]>): SiteDisabledModelsIndex {
  const index: SiteDisabledModelsIndex = new Map();
  for (const [siteId, models] of entries) {
    const raw = new Set<string>();
    const canonical = new Set<string>();
    for (const model of models) {
      const lower = model.toLowerCase();
      raw.add(lower);
      // mirror loadSiteDisabledModelsIndex canonicalization lightly for test fixtures
      const slash = lower.split('/').filter(Boolean);
      const base = (slash.length > 1 ? slash[slash.length - 1]! : lower).replace(/:free$/i, '').replace(/-free$/i, '');
      if (base) canonical.add(base);
    }
    index.set(siteId, { raw, canonical });
  }
  return index;
}

describe('isModelDisabledForSite', () => {
  it('matches exact raw names case-insensitively', () => {
    const index = indexFrom([[1, ['gpt-4o']]]);
    expect(isModelDisabledForSite(index, 1, 'GPT-4o')).toBe(true);
    expect(isModelDisabledForSite(index, 1, 'gpt-4o-mini')).toBe(false);
    expect(isModelDisabledForSite(index, 2, 'gpt-4o')).toBe(false);
  });

  it('matches provider-prefixed and :free aliases via canonical name', () => {
    const index = indexFrom([[88, ['qwen/qwen3.8-max-preview:free']]]);
    expect(isModelDisabledForSite(index, 88, 'qwen3.8-max-preview')).toBe(true);
    expect(isModelDisabledForSite(index, 88, 'qwen/qwen3.8-max-preview')).toBe(true);
    expect(isModelDisabledForSite(index, 88, 'QWEN/qwen3.8-max-preview:free')).toBe(true);
  });

  it('matches when disabled list stores canonical short name', () => {
    const index = indexFrom([[88, ['qwen3.8-max-preview']]]);
    expect(isModelDisabledForSite(index, 88, 'qwen/qwen3.8-max-preview:free')).toBe(true);
  });
});
