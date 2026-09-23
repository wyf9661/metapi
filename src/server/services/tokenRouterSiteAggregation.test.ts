import { describe, expect, it } from 'vitest';
import { rankShadowCandidates } from './routeScoringShadow.js';
import {
  aggregateSiteScoresPerAccount,
  SAME_ACCOUNT_EXTRA_KEY_BONUS_CAP,
} from './tokenRouterSiteAggregation.js';

type SimInput = {
  channelId: number;
  siteId: number;
  accountId: number;
  score: number;
};

/**
 * Aggregate per ACCOUNT (best key score per account + bounded extra-key bonus),
 * then per SITE as the sum over its accounts.
 */
function siteAggregatedProbabilities(inputs: SimInput[]): Map<number, number> {
  const siteScores = aggregateSiteScoresPerAccount(
    inputs.map((i) => ({
      siteId: i.siteId,
      accountId: i.accountId,
      channelId: i.channelId,
      score: i.score,
    })),
  );
  const total = [...siteScores.values()].reduce((s, v) => s + v, 0);
  const probs = new Map<number, number>();
  for (const [siteId, score] of siteScores) probs.set(siteId, score / total);
  return probs;
}

function mkScored(
  spec: Array<{ siteId: number; nKeys: number; nAccounts: number; score?: number }>,
): SimInput[] {
  const rows: SimInput[] = [];
  let ch = 1;
  for (const { siteId, nKeys, nAccounts, score } of spec) {
    for (let i = 0; i < nKeys; i++) {
      rows.push({
        channelId: ch++,
        siteId,
        accountId: siteId * 1000 + (i % nAccounts),
        score: score ?? 1,
      });
    }
  }
  return rows;
}

describe('site aggregation: quota-aware per-account weighting', () => {
  it('keys sharing one account do NOT multiply the site score linearly', () => {
    // A=1 key, B=5 keys same account, C=40 keys same account, all equally healthy.
    const probs = siteAggregatedProbabilities(mkScored([
      { siteId: 1, nKeys: 1, nAccounts: 1 },
      { siteId: 2, nKeys: 5, nAccounts: 1 },
      { siteId: 3, nKeys: 40, nAccounts: 1 },
    ]));
    // Old behavior (sum over keys) would be 2.2% / 10.9% / 87.0%.
    // New behavior: near-equal thirds, multi-key site slightly ahead but capped.
    expect(probs.get(1)!).toBeGreaterThan(0.24);
    expect(probs.get(1)!).toBeLessThan(0.33);
    expect(probs.get(2)!).toBeGreaterThan(0.30);
    expect(probs.get(2)!).toBeLessThan(0.38);
    expect(probs.get(3)!).toBeGreaterThan(0.33);
    expect(probs.get(3)!).toBeLessThan(0.45);
    // Still monotonic: more keys (even same-account) => slightly higher share.
    expect(probs.get(3)!).toBeGreaterThan(probs.get(2)!);
    expect(probs.get(2)!).toBeGreaterThan(probs.get(1)!);
  });

  it('independent accounts DO multiply the site score (real quota)', () => {
    // C has 40 keys from 40 different accounts — 40 independent quotas.
    const probs = siteAggregatedProbabilities(mkScored([
      { siteId: 1, nKeys: 1, nAccounts: 1 },
      { siteId: 2, nKeys: 5, nAccounts: 1 },
      { siteId: 3, nKeys: 40, nAccounts: 40 },
    ]));
    // Should stay close to the old sum-based shares (dominant site).
    expect(probs.get(3)!).toBeGreaterThan(0.75);
    expect(probs.get(1)!).toBeLessThan(0.06);
  });

  it('extra-key bonus is bounded by the cap regardless of key count', () => {
    expect(SAME_ACCOUNT_EXTRA_KEY_BONUS_CAP).toBe(1.3);
    // 40 keys one account: bonus must be the cap, not 40x.
    const probs = siteAggregatedProbabilities(mkScored([
      { siteId: 1, nKeys: 1, nAccounts: 1, score: 1 },
      { siteId: 2, nKeys: 40, nAccounts: 1, score: 1 },
    ]));
    const ratio = probs.get(2)! / probs.get(1)!;
    // 40 identical keys same-account: bonus is capped at 1.3 => ratio 1.3
    expect(ratio).toBeCloseTo(SAME_ACCOUNT_EXTRA_KEY_BONUS_CAP, 5);
  });

  it('diverse key scores within one account: best key represents the quota', () => {
    // One account with keys of varying health — only the best counts (plus bonus).
    const probs = siteAggregatedProbabilities(mkScored([
      { siteId: 1, nKeys: 1, nAccounts: 1, score: 1 },
      { siteId: 2, nKeys: 10, nAccounts: 1, score: 0.5 },
    ]));
    // Site 2 score = 0.5 * min(1.3, 1 + 0.1*ln(10)) ≈ 0.5*1.263 = 0.631 < 1
    expect(probs.get(2)!).toBeLessThan(probs.get(1)!);
  });

  it('rankShadowCandidates still works with the aggregated inputs (smoke)', () => {
    // Full pipeline: score via rankShadowCandidates then aggregate per account.
    const inputs = mkScored([
      { siteId: 1, nKeys: 1, nAccounts: 1 },
      { siteId: 2, nKeys: 40, nAccounts: 1 },
    ]).map((i) => ({
      channelId: i.channelId, siteId: i.siteId, siteName: `s${i.siteId}`,
      accountId: i.accountId, accountUsername: `a${i.accountId}`,
      balance: null, balanceKnown: false, credentialKind: 'apikey' as const,
      channelWeight: 10, successCount: 100, failCount: 0,
      unitCost: 0, costSource: 'unknown' as const,
      runtimeHealth: 1, historicalHealth: 1,
      recentSuccessRate: null, recentSampleCount: 0,
      loadMultiplier: 1, manualSiteWeight: 1,
      connectivity: null, protocolAffinity: 1,
      ttftEwmaMs: null, tpsEwma: null,
    }));
    const ranked = rankShadowCandidates(inputs, { probabilityFloor: 0.05 });
    const active = ranked.candidates.filter((c) => !c.factors.exclusion && c.score > 0);
    const siteScores = aggregateSiteScoresPerAccount(
      active.map((c) => ({ siteId: c.siteId, accountId: c.accountId, channelId: c.channelId, score: c.score })),
    );
    const total = [...siteScores.values()].reduce((s, v) => s + v, 0);
    const share2 = (siteScores.get(2) ?? 0) / total;
    // 40 same-account keys: share must be near 0.5, far from the old ~0.97.
    expect(share2).toBeGreaterThan(0.45);
    expect(share2).toBeLessThan(0.60);
  });
});
