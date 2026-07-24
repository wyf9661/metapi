import { db, schema } from '../db/index.js';
import { canonicalizeModelName } from '../shared/modelCanonicalization.js';

export type SiteDisabledModelsIndex = Map<number, {
  raw: Set<string>;
  canonical: Set<string>;
}>;

function normalizeRawModelName(modelName: string): string {
  return String(modelName || '').trim().toLowerCase();
}

/**
 * Load all site_disabled_models rows into an in-memory index.
 * Matching is case-insensitive on the raw name AND on the canonical name
 * (provider prefix / :free packaging stripped) so disabling either form
 * blocks both.
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
      entry = { raw: new Set(), canonical: new Set() };
      index.set(siteId, entry);
    }
    entry.raw.add(raw);
    const canonical = canonicalizeModelName(row.modelName);
    if (canonical) entry.canonical.add(canonical);
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
  if (!entry || (entry.raw.size === 0 && entry.canonical.size === 0)) return false;
  const raw = normalizeRawModelName(modelName || '');
  if (!raw) return false;
  if (entry.raw.has(raw)) return true;
  const canonical = canonicalizeModelName(modelName || '');
  if (canonical && entry.canonical.has(canonical)) return true;
  return false;
}
