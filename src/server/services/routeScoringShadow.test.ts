import { describe, expect, it } from 'vitest';
import {
  computeBalanceCoverage,
  computeBalanceFactor,
  formatShadowSelectionLog,
  rankShadowCandidates,
  type ShadowCandidateInput,
} from './routeScoringShadow.js';

function base(partial: Partial<ShadowCandidateInput> & Pick<ShadowCandidateInput, 'channelId' | 'siteId' | 'accountId'>): ShadowCandidateInput {
  return {
    channelId: partial.channelId,
    siteId: partial.siteId,
    siteName: partial.siteName ?? `s${partial.siteId}`,
    accountId: partial.accountId,
    accountUsername: partial.accountUsername ?? null,
    balance: partial.balance ?? 100,
    balanceKnown: partial.balanceKnown ?? true,
    credentialKind: partial.credentialKind ?? (partial.balanceKnown === false ? 'apikey' : 'session'),
    channelWeight: partial.channelWeight ?? 10,
    successCount: partial.successCount ?? 50,
    failCount: partial.failCount ?? 5,
    unitCost: partial.unitCost ?? 0.01,
    costSource: partial.costSource ?? 'observed',
    runtimeHealth: partial.runtimeHealth ?? 1,
    historicalHealth: partial.historicalHealth ?? 1,
    recentSuccessRate: partial.recentSuccessRate ?? 0.95,
    recentSampleCount: partial.recentSampleCount ?? 10,
    loadMultiplier: partial.loadMultiplier ?? 1,
    manualSiteWeight: partial.manualSiteWeight ?? 1,
    connectivity: partial.connectivity ?? null,
    protocolAffinity: partial.protocolAffinity ?? 1,
    ttftEwmaMs: partial.ttftEwmaMs ?? null,
  };
}

describe('routeScoringShadow', () => {
  it('excludes known session accounts whose balance cannot cover one request', () => {
    const result = rankShadowCandidates([
      base({ channelId: 1, siteId: 1, accountId: 1, balance: 0, balanceKnown: true, credentialKind: 'session', unitCost: 0.001 }),
      base({ channelId: 2, siteId: 2, accountId: 2, balance: 50, balanceKnown: true, credentialKind: 'session', unitCost: 0.02 }),
    ]);
    expect(result.selectedChannelId).toBe(2);
    expect(result.excluded).toContainEqual({ channelId: 1, reason: '余额不足' });
    const zero = result.candidates.find((c) => c.channelId === 1)!;
    expect(zero.probability).toBe(0);
  });

  it('prefers direct API-key accounts over low session balances (shared keys)', () => {
    const result = rankShadowCandidates([
      base({
        channelId: 1,
        siteId: 1,
        accountId: 1,
        balance: 0,
        balanceKnown: false,
        credentialKind: 'apikey',
        unitCost: 0.02,
      }),
      base({
        channelId: 2,
        siteId: 2,
        accountId: 2,
        balance: 3,
        balanceKnown: true,
        credentialKind: 'session',
        unitCost: 0.01,
      }),
    ]);
    expect(result.selectedChannelId).toBe(1);
    const apiKey = result.candidates.find((c) => c.channelId === 1)!;
    expect(apiKey.factors.balance).toBeCloseTo(1.15, 2);
    expect(apiKey.balanceCoverage).toBeNull();
  });

  it('boosts direct API-key balance=0 instead of treating it as depleted', () => {
    const result = rankShadowCandidates([
      base({ channelId: 1, siteId: 1, accountId: 1, balance: 0, balanceKnown: false, credentialKind: 'apikey', unitCost: 0.01 }),
      base({ channelId: 2, siteId: 2, accountId: 2, balance: 10, balanceKnown: true, credentialKind: 'session', unitCost: 0.01 }),
    ]);
    const directKey = result.candidates.find((c) => c.channelId === 1)!;
    expect(directKey.balanceCoverage).toBeNull();
    expect(directKey.factors.balance).toBeCloseTo(1.15, 2);
    expect(directKey.factors.exclusion).toBeNull();
    // API key should outrank modest session balance at same cost
    expect(result.selectedChannelId).toBe(1);
  });

  it('prefers cheaper healthy channel when balances are sufficient', () => {
    const result = rankShadowCandidates([
      base({ channelId: 1, siteId: 1, accountId: 1, balance: 100, unitCost: 0.05 }),
      base({ channelId: 2, siteId: 2, accountId: 2, balance: 100, unitCost: 0.01 }),
    ]);
    expect(result.selectedChannelId).toBe(2);
    const cheap = result.candidates.find((c) => c.channelId === 2)!;
    const expensive = result.candidates.find((c) => c.channelId === 1)!;
    expect(cheap.probability).toBeGreaterThan(expensive.probability);
  });

  it('does not let huge balance alone dominate reliability', () => {
    const result = rankShadowCandidates([
      base({
        channelId: 1,
        siteId: 1,
        accountId: 1,
        balance: 100000,
        unitCost: 0.01,
        successCount: 10,
        failCount: 40,
        recentSuccessRate: 0.2,
        recentSampleCount: 20,
      }),
      base({
        channelId: 2,
        siteId: 2,
        accountId: 2,
        balance: 30,
        unitCost: 0.015,
        successCount: 80,
        failCount: 5,
        recentSuccessRate: 0.96,
        recentSampleCount: 20,
      }),
    ]);
    expect(result.selectedChannelId).toBe(2);
  });

  it('coverage and balance factor behave for edge balances', () => {
    expect(computeBalanceCoverage(0, 0.01)).toBe(0);
    expect(computeBalanceFactor(0).factor).toBe(0);
    expect(computeBalanceFactor(0).exclusion).toBe('余额不足');
    expect(computeBalanceFactor(null).factor).toBeCloseTo(0.85, 2);
    expect(computeBalanceFactor(200).factor).toBeGreaterThan(0.8);
  });

  it('formats a compact shadow log line', () => {
    const shadow = rankShadowCandidates([
      base({ channelId: 1, siteId: 1, accountId: 1, balance: 0 }),
      base({ channelId: 2, siteId: 2, accountId: 2, balance: 20 }),
    ]);
    const line = formatShadowSelectionLog({
      requestedModel: 'gpt-5.6-sol',
      liveChannelId: 1,
      shadow,
    });
    expect(line).toContain('[route-shadow]');
    expect(line).toContain('model=gpt-5.6-sol');
    expect(line).toContain('agree=0');
    expect(line).toContain('bal=');
    expect(line).toContain('conn=');
  });

  it('strongly demotes known-false connectivity against healthy peers', () => {
    const result = rankShadowCandidates([
      base({
        channelId: 1,
        siteId: 1,
        accountId: 1,
        connectivity: false,
        unitCost: 0.01,
        credentialKind: 'session',
        balanceKnown: true,
        balance: 40,
      }),
      base({
        channelId: 2,
        siteId: 2,
        accountId: 2,
        connectivity: true,
        unitCost: 0.01,
        credentialKind: 'session',
        balanceKnown: true,
        balance: 40,
      }),
    ]);
    expect(result.selectedChannelId).toBe(2);
    const dead = result.candidates.find((c) => c.channelId === 1)!;
    const live = result.candidates.find((c) => c.channelId === 2)!;
    expect(dead.factors.connectivity).toBeLessThan(live.factors.connectivity);
    expect(dead.probability).toBeLessThan(0.2);
    expect(live.probability).toBeGreaterThan(0.8);
  });

  it('boosts codex/responses protocol affinity on ties', () => {
    const result = rankShadowCandidates([
      base({ channelId: 1, siteId: 1, accountId: 1, protocolAffinity: 1, unitCost: 0.01 }),
      base({ channelId: 2, siteId: 2, accountId: 2, protocolAffinity: 1.18, unitCost: 0.01 }),
    ]);
    expect(result.selectedChannelId).toBe(2);
    const plain = result.candidates.find((c) => c.channelId === 1)!;
    const codex = result.candidates.find((c) => c.channelId === 2)!;
    expect(codex.probability).toBeGreaterThan(plain.probability);
    expect(codex.factors.protocolAffinity).toBeCloseTo(1.18, 2);
  });

  it('keeps untested connectivity neutral relative to proven-true boost', () => {
    const result = rankShadowCandidates([
      base({ channelId: 1, siteId: 1, accountId: 1, connectivity: null, unitCost: 0.01 }),
      base({ channelId: 2, siteId: 2, accountId: 2, connectivity: true, unitCost: 0.01 }),
    ]);
    const unknown = result.candidates.find((c) => c.channelId === 1)!;
    const proven = result.candidates.find((c) => c.channelId === 2)!;
    expect(proven.probability).toBeGreaterThan(unknown.probability);
    expect(unknown.factors.connectivity).toBe(1);
    expect(proven.factors.connectivity).toBeGreaterThan(1);
  });

  it('raises the score of fast first-token sites and lowers slow ones', () => {
    const result = rankShadowCandidates([
      base({ channelId: 1, siteId: 1, accountId: 1, unitCost: 0.01, ttftEwmaMs: 500 }),
      base({ channelId: 2, siteId: 2, accountId: 2, unitCost: 0.01, ttftEwmaMs: 8000 }),
    ]);
    const fast = result.candidates.find((c) => c.channelId === 1)!;
    const slow = result.candidates.find((c) => c.channelId === 2)!;
    expect(fast.factors.ttft).toBeGreaterThan(slow.factors.ttft);
    expect(fast.factors.ttft).toBeGreaterThan(1);
    expect(slow.factors.ttft).toBeLessThan(1);
    expect(fast.probability).toBeGreaterThan(slow.probability);
  });

  it('treats missing TTFT samples as neutral', () => {
    const result = rankShadowCandidates([
      base({ channelId: 1, siteId: 1, accountId: 1, unitCost: 0.01, ttftEwmaMs: null }),
      base({ channelId: 2, siteId: 2, accountId: 2, unitCost: 0.01, ttftEwmaMs: 2000 }),
    ]);
    const unknown = result.candidates.find((c) => c.channelId === 1)!;
    const baseline = result.candidates.find((c) => c.channelId === 2)!;
    expect(unknown.factors.ttft).toBe(1);
    expect(baseline.factors.ttft).toBeCloseTo(1, 3);
  });

  it('gives every healthy candidate a minimum probability floor', () => {
    // One dominant site + many weak-but-healthy sites. Without the floor the
    // weak sites would get ~0%; the floor keeps each one selectable.
    const inputs = [
      base({ channelId: 1, siteId: 1, accountId: 1, credentialKind: 'apikey', unitCost: 0.01, successCount: 500, failCount: 5 }),
      base({ channelId: 2, siteId: 2, accountId: 2, unitCost: 0.01, successCount: 1, failCount: 0 }),
      base({ channelId: 3, siteId: 3, accountId: 3, unitCost: 0.01, successCount: 1, failCount: 0 }),
      base({ channelId: 4, siteId: 4, accountId: 4, unitCost: 0.01, successCount: 1, failCount: 0 }),
      base({ channelId: 5, siteId: 5, accountId: 5, unitCost: 0.01, successCount: 1, failCount: 0 }),
    ];
    const result = rankShadowCandidates(inputs, { probabilityFloor: 0.05 });
    for (const candidate of result.candidates) {
      // Every healthy candidate keeps at least the floor (before renormalization
      // the floor is 0.05; after renormalization it shrinks but stays > 0).
      expect(candidate.probability).toBeGreaterThan(0.02);
    }
    // The dominant site still wins the largest share.
    const dominant = result.candidates.find((c) => c.channelId === 1)!;
    const weakest = result.candidates.find((c) => c.channelId === 5)!;
    expect(dominant.probability).toBeGreaterThan(weakest.probability);
  });

  it('decays the floor as reliability is proven', () => {
    const inputs = [
      base({ channelId: 1, siteId: 1, accountId: 1, unitCost: 0.01, successCount: 200, failCount: 2 }),
      base({ channelId: 2, siteId: 2, accountId: 2, unitCost: 0.01, successCount: 0, failCount: 0 }),
    ];
    const result = rankShadowCandidates(inputs, { probabilityFloor: 0.1 });
    const proven = result.candidates.find((c) => c.channelId === 1)!;
    const fresh = result.candidates.find((c) => c.channelId === 2)!;
    // The proven site's high reliability shrinks its floor; the fresh site
    // keeps the full floor, so it gets a meaningful share.
    expect(proven.probability).toBeGreaterThanOrEqual(0.5);
    expect(fresh.probability).toBeGreaterThan(0.05);
    expect(proven.factors.minShare).toBeGreaterThan(0);
  });
});
