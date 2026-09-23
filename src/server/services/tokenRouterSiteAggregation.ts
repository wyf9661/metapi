/**
 * Quota-aware site score aggregation for balanced-v2 site-level selection.
 *
 * Why: a site's real capacity is its number of INDEPENDENT quotas (accounts),
 * not its number of keys. Keys that share one account share one quota pool, so
 * summing per-key scores let a site with dozens of same-account keys multiply
 * its traffic share by key count — draining one quota pool disproportionately.
 *
 * Rule: site score = Σ over accounts (best key score in that account)
 *                     × (1 + BONUS_RATE·ln(1 + extraKeys)) capped at BONUS_CAP.
 * The small logarithmic bonus reflects that many sites rate-limit per key
 * (key-level RPM), so extra same-account keys do add a little concurrency.
 */

export const SAME_ACCOUNT_EXTRA_KEY_BONUS_RATE = 0.1;
export const SAME_ACCOUNT_EXTRA_KEY_BONUS_CAP = 1.3;

export type ScoredChannelRef = {
  siteId: number;
  accountId: number;
  channelId: number;
  score: number;
};

/**
 * best-score-per-account aggregation with a bounded logarithmic bonus for
 * additional keys inside the same account. Returns siteId -> aggregated score.
 */
export function aggregateSiteScoresPerAccount(
  channels: ScoredChannelRef[],
): Map<number, number> {
  const bestPerAccount = new Map<string, { siteId: number; score: number }>();
  const keyCountPerAccount = new Map<string, number>();
  for (const row of channels) {
    if (!Number.isFinite(row.score) || row.score <= 0) continue;
    const accountKey = `${row.siteId}::${row.accountId}`;
    keyCountPerAccount.set(accountKey, (keyCountPerAccount.get(accountKey) ?? 0) + 1);
    const current = bestPerAccount.get(accountKey);
    if (!current || row.score > current.score) {
      bestPerAccount.set(accountKey, { siteId: row.siteId, score: row.score });
    }
  }

  const siteScores = new Map<number, number>();
  for (const [accountKey, entry] of bestPerAccount) {
    const nKeys = keyCountPerAccount.get(accountKey) ?? 1;
    const bonus = Math.min(
      SAME_ACCOUNT_EXTRA_KEY_BONUS_CAP,
      1 + SAME_ACCOUNT_EXTRA_KEY_BONUS_RATE * Math.log(1 + (nKeys - 1)),
    );
    siteScores.set(entry.siteId, (siteScores.get(entry.siteId) ?? 0) + entry.score * bonus);
  }
  return siteScores;
}
