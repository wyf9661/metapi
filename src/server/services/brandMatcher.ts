import { getAllBrandNames as getSharedBrandNames, getMatchingBrandNames } from '../shared/modelBrand.js';

export type BlockedBrandRule = string;

const KNOWN_BRANDS = new Set(getSharedBrandNames());
const CANONICAL_BRAND_BY_KEY = new Map(
  getSharedBrandNames().map((brand) => [normalizeBrandKey(brand), brand] as const),
);
const KNOWN_BRAND_LIST = Array.from(KNOWN_BRANDS);

function normalizeBrandKey(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function getAllBrandNames(): string[] {
  return KNOWN_BRAND_LIST;
}

export function getBlockedBrandRules(blockedBrands: string[]): BlockedBrandRule[] {
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const brand of blockedBrands) {
    const canonical = CANONICAL_BRAND_BY_KEY.get(normalizeBrandKey(brand));
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    rules.push(canonical);
  }
  return rules;
}

export function isModelBlockedByBrand(modelName: string, rules: BlockedBrandRule[]): boolean {
  if (!modelName || rules.length === 0) return false;
  const matchedBrands = new Set(getMatchingBrandNames(modelName));
  return rules.some((rule) => matchedBrands.has(rule));
}
