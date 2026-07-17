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
  };
}

describe('routeScoringShadow', () => {
  it('softly penalizes known session zero balance accounts', () => {
    const result = rankShadowCandidates([
      base({ channelId: 1, siteId: 1, accountId: 1, balance: 0, balanceKnown: true, credentialKind: 'session', unitCost: 0.001 }),
      base({ channelId: 2, siteId: 2, accountId: 2, balance: 50, balanceKnown: true, credentialKind: 'session', unitCost: 0.02 }),
    ]);
    expect(result.selectedChannelId).toBe(2);
    expect(result.excluded.some((e) => e.channelId === 1)).toBe(false);
    const zero = result.candidates.find((c) => c.channelId === 1)!;
    expect(zero.probability).toBeGreaterThan(0);
    expect(zero.probability).toBeLessThan(0.15);
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
    expect(computeBalanceFactor(0).factor).toBeCloseTo(0.005, 3);
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
  });
});
