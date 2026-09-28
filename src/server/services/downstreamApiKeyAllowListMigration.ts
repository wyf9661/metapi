import { and, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  buildCredentialRefKey,
  normalizeAllowedCredentialRefsInput,
  normalizeAllowedSiteIdsInput,
  toPersistenceJson,
} from './downstreamApiKeyService.js';
import type { DownstreamCredentialRef } from './downstreamPolicyTypes.js';

export type DownstreamKeyExclusionMigrationResult = {
  converted: number;
};

function parseLegacyList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  const text = raw.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// A row still needs the conversion when it carries a non-empty legacy exclusion
// list and has never been written by the allow-list code path. Rows that already
// hold an allow-list are skipped even if a stale legacy value is still on the row
// (the two columns together are the "already migrated" marker, not the legacy one
// alone) — otherwise a re-run would invert the list a second time.
const pendingWhere = () => and(
  isNull(schema.downstreamApiKeys.allowedSiteIds),
  isNull(schema.downstreamApiKeys.allowedCredentialRefs),
  or(
    sql`trim(coalesce(${schema.downstreamApiKeys.excludedSiteIds}, '')) NOT IN ('', '[]', 'null')`,
    sql`trim(coalesce(${schema.downstreamApiKeys.excludedCredentialRefs}, '')) NOT IN ('', '[]', 'null')`,
  ),
);

/**
 * Data-driven early exit for the startup conversion. Mirrors the other boot
 * normalisation probes: no permanent "already ran" marker, because a backup
 * restore or import can reintroduce the legacy shape at any time.
 */
export async function hasPendingDownstreamKeyExclusionMigration(): Promise<boolean> {
  const row = await db.select({ id: schema.downstreamApiKeys.id })
    .from(schema.downstreamApiKeys)
    .where(pendingWhere())
    .limit(1)
    .get();
  return !!row;
}

/**
 * Convert the legacy `excluded_*` lists on downstream API keys into the
 * allow-list columns.
 *
 * The universe used for the subtraction is the same one the editor offers:
 * sites that currently have at least one account, and the credentials attached
 * to those accounts (each account's default API key plus every bound token). A
 * legacy list that was empty stays empty — an empty allow-list means "no
 * restriction", so materialising a snapshot there would freeze a key onto
 * today's sites without anyone asking for that.
 */
export async function migrateDownstreamKeyExclusionsToAllowLists(): Promise<DownstreamKeyExclusionMigrationResult> {
  const pendingRows = await db.select().from(schema.downstreamApiKeys).where(pendingWhere()).all();
  if (pendingRows.length === 0) {
    return { converted: 0 };
  }

  const accountRows = await db.select({
    id: schema.accounts.id,
    siteId: schema.accounts.siteId,
    apiToken: schema.accounts.apiToken,
  }).from(schema.accounts).all();

  const tokenRows = await db.select({
    id: schema.accountTokens.id,
    accountId: schema.accountTokens.accountId,
  }).from(schema.accountTokens).all();

  const siteIdByAccountId = new Map<number, number>();
  for (const account of accountRows) {
    const siteId = Math.trunc(Number(account.siteId));
    const accountId = Math.trunc(Number(account.id));
    if (Number.isFinite(siteId) && siteId > 0 && Number.isFinite(accountId) && accountId > 0) {
      siteIdByAccountId.set(accountId, siteId);
    }
  }

  const universeSiteIds = normalizeAllowedSiteIdsInput(accountRows.map((account) => account.siteId));

  const universeCredentialRefs = normalizeAllowedCredentialRefsInput([
    ...accountRows
      .filter((account) => String(account.apiToken || '').trim())
      .map((account) => ({
        kind: 'default_api_key',
        siteId: account.siteId,
        accountId: account.id,
      })),
    ...tokenRows
      .map((token) => ({
        kind: 'account_token',
        siteId: siteIdByAccountId.get(Math.trunc(Number(token.accountId))) ?? 0,
        accountId: token.accountId,
        tokenId: token.id,
      }))
      .filter((ref) => ref.siteId > 0),
  ]);

  let converted = 0;
  for (const row of pendingRows) {
    const legacySiteIds = normalizeAllowedSiteIdsInput(parseLegacyList(row.excludedSiteIds));
    const legacyCredentialRefs = normalizeAllowedCredentialRefsInput(parseLegacyList(row.excludedCredentialRefs));

    const allowedSiteIds = legacySiteIds.length > 0
      ? universeSiteIds.filter((siteId) => !legacySiteIds.includes(siteId))
      : [];

    let allowedCredentialRefs: DownstreamCredentialRef[] = [];
    if (legacyCredentialRefs.length > 0) {
      const excludedKeys = new Set(legacyCredentialRefs.map((ref) => buildCredentialRefKey(ref)));
      allowedCredentialRefs = universeCredentialRefs.filter(
        (ref) => !excludedKeys.has(buildCredentialRefKey(ref)),
      );
    }

    await db.update(schema.downstreamApiKeys)
      .set({
        allowedSiteIds: toPersistenceJson(allowedSiteIds),
        allowedCredentialRefs: toPersistenceJson(allowedCredentialRefs),
        // Cleared in the same write: "legacy list present" then always means
        // "not converted yet", which keeps this pass idempotent and keeps a
        // restored old backup on the same single conversion path.
        excludedSiteIds: null,
        excludedCredentialRefs: null,
      })
      .where(sql`${schema.downstreamApiKeys.id} = ${row.id}`)
      .run();
    converted += 1;
  }

  return { converted };
}
