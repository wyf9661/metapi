import { getAllBrandNames as getSharedBrandNames, getBrand } from '../shared/modelBrand.js';

export type BlockedBrandRule = string;

const KNOWN_BRANDS = new Set(getSharedBrandNames());
const KNOWN_BRAND_LIST = Array.from(KNOWN_BRANDS);

export function getAllBrandNames(): string[] {
  return KNOWN_BRAND_LIST;
}

export function getBlockedBrandRules(blockedBrands: string[]): BlockedBrandRule[] {
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const brand of blockedBrands) {
    const normalized = String(brand || '').trim();
    if (!normalized || seen.has(normalized) || !KNOWN_BRANDS.has(normalized)) continue;
    seen.add(normalized);
    rules.push(normalized);
  }
  return rules;
}

export function isModelBlockedByBrand(modelName: string, rules: BlockedBrandRule[]): boolean {
  if (!modelName || rules.length === 0) return false;
  const brand = getBrand(modelName);
  return !!brand && rules.includes(brand.name);
}
