import { db, schema } from '../db/index.js';
import { canonicalizeModelName } from '../shared/modelCanonicalization.js';

export type SiteDisabledModelsIndex = Map<number, {
  raw: Set<string>;
  canonicalFree: Set<string>;
  canonicalNonFree: Set<string>;
}>;

function normalizeRawModelName(modelName: string): string {
  return String(modelName || '').trim().toLowerCase();
}

/**
 * Whether a model name carries a free-suffix packaging label (:free / -free).
 * Free variants are distinct quota/rate tiers on relay sites (e.g.
 * deepseek-v4-flash vs deepseek-v4-flash-free), so disabling a non-free model
 * must not block its free sibling and vice versa.
 */
function hasFreeSuffix(modelName: string): boolean {
  return /:free$/i.test(String(modelName || '').trim()) || /-free$/i.test(String(modelName || '').trim());
}

/**
 * Load all site_disabled_models rows into an in-memory index.
 * Matching is case-insensitive on the raw name. Provider-prefix aliases are
 * matched via the canonical name, but the :free / -free packaging state is
 * preserved so that disabling a non-free model never blocks the free variant
 * (and the reverse). Disabling either form only blocks the same free-ness form.
 */
export async function loadSiteDisabledModelsIndex(): Promise<SiteDisabledModelsIndex> {
  const rows = await db.select({
    siteId: schema.siteDisabledModels.siteId,
    modelName: schema.siteDisabledModels.modelName,
  }).from(schema.siteDisabledModels).all();

  const index: SiteDisabledModelsIndex = new Map();
  for (const row of rows) {
    const siteId = Number(row.siteId);
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    const raw = normalizeRawModelName(row.modelName);
    if (!raw) continue;
    let entry = index.get(siteId);
    if (!entry) {
      entry = { raw: new Set(), canonicalFree: new Set(), canonicalNonFree: new Set() };
      index.set(siteId, entry);
    }
    entry.raw.add(raw);
    const canonical = canonicalizeModelName(row.modelName);
    if (canonical) {
      if (hasFreeSuffix(row.modelName)) {
        entry.canonicalFree.add(canonical);
      } else {
        entry.canonicalNonFree.add(canonical);
      }
    }
  }
  return index;
}

export function isModelDisabledForSite(
  index: SiteDisabledModelsIndex | null | undefined,
  siteId: number | null | undefined,
  modelName: string | null | undefined,
): boolean {
  if (!index || siteId == null || !Number.isFinite(siteId) || siteId <= 0) return false;
  const entry = index.get(siteId);
  if (!entry || (entry.raw.size === 0 && entry.canonicalFree.size === 0 && entry.canonicalNonFree.size === 0)) return false;
  const raw = normalizeRawModelName(modelName || '');
  if (!raw) return false;
  if (entry.raw.has(raw)) return true;
  const free = hasFreeSuffix(modelName || '');
  const canonical = canonicalizeModelName(modelName || '');
  if (!canonical) return false;
  const canonicalSet = free ? entry.canonicalFree : entry.canonicalNonFree;
  return canonicalSet.has(canonical);
}
