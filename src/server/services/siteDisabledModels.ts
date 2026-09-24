import { db, schema } from '../db/index.js';
import { canonicalizeModelName } from '../shared/modelCanonicalization.js';

export type SiteDisabledModelsIndex = Map<number, {
  // Site-wide rows (account_id NULL): match every account of the site.
  raw: Set<string>;
  canonicalFree: Set<string>;
  canonicalNonFree: Set<string>;
  // Per-account rows (account_id set): keyed by account id.
  byAccount: Map<number, {
    raw: Set<string>;
    canonicalFree: Set<string>;
    canonicalNonFree: Set<string>;
  }>;
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

function makeEntry() {
  return { raw: new Set<string>(), canonicalFree: new Set<string>(), canonicalNonFree: new Set<string>() };
}

/**
 * Load all site_disabled_models rows into an in-memory index.
 *
 * A row with account_id NULL is site-wide: it matches every key of the site.
 * A row with account_id set is per-key: it matches only that account. Both are
 * matched case-insensitively on the raw name, with provider-prefix aliases
 * resolved via the canonical name. The :free / -free packaging state is
 * preserved so disabling a non-free model never blocks the free variant (and
 * the reverse).
 */
export async function loadSiteDisabledModelsIndex(): Promise<SiteDisabledModelsIndex> {
  const rows = await db.select({
    siteId: schema.siteDisabledModels.siteId,
    accountId: schema.siteDisabledModels.accountId,
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
      entry = { raw: new Set(), canonicalFree: new Set(), canonicalNonFree: new Set(), byAccount: new Map() };
      index.set(siteId, entry);
    }

    const accountId = row.accountId == null ? null : Number(row.accountId);
    const target = accountId != null && Number.isFinite(accountId) && accountId > 0
      ? (entry.byAccount.get(accountId) ?? (entry.byAccount.set(accountId, makeEntry()), entry.byAccount.get(accountId)!))
      : entry;

    target.raw.add(raw);
    const canonical = canonicalizeModelName(row.modelName);
    if (canonical) {
      if (hasFreeSuffix(row.modelName)) {
        target.canonicalFree.add(canonical);
      } else {
        target.canonicalNonFree.add(canonical);
      }
    }
  }
  return index;
}

function matches(entry: { raw: Set<string>; canonicalFree: Set<string>; canonicalNonFree: Set<string> }, modelName: string): boolean {
  const raw = normalizeRawModelName(modelName);
  if (!raw) return false;
  if (entry.raw.has(raw)) return true;
  const free = hasFreeSuffix(modelName);
  const canonical = canonicalizeModelName(modelName);
  if (!canonical) return false;
  const canonicalSet = free ? entry.canonicalFree : entry.canonicalNonFree;
  return canonicalSet.has(canonical);
}

/**
 * Whether a model is disabled for a site, optionally scoped to one key.
 *
 * Site-wide rows always apply. Per-key rows apply only when `accountId` matches
 * and the caller is evaluating that account — pass accountId to get the
 * per-key semantics, omit it to see only site-wide disabling (used by
 * site-level views that have no account context).
 */
export function isModelDisabledForSite(
  index: SiteDisabledModelsIndex | null | undefined,
  siteId: number | null | undefined,
  modelName: string | null | undefined,
  accountId?: number | null,
): boolean {
  if (!index || siteId == null || !Number.isFinite(siteId) || siteId <= 0) return false;
  const entry = index.get(siteId);
  if (!entry) return false;

  // Site-wide rows apply to every key.
  if (matches(entry, modelName || '')) return true;

  // Per-key rows apply only when evaluating that key.
  if (accountId != null && Number.isFinite(accountId) && accountId > 0) {
    const perAccount = entry.byAccount.get(accountId);
    if (perAccount && matches(perAccount, modelName || '')) return true;
  }
  return false;
}
