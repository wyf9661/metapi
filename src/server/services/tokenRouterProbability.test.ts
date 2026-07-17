import { describe, expect, it } from 'vitest';
import {
  buildContributionRanks,
  countCandidatesBySite,
  normalizeContributions,
  normalizeValueScores,
  rankContributionIndices,
  selectWeightedIndex,
} from './tokenRouterProbability.js';

describe('tokenRouterProbability', () => {
  it('normalizes value scores using the existing zero baseline', () => {
    expect(normalizeValueScores([])).toEqual([]);
    expect(normalizeValueScores([1, 2, 3])).toEqual([1 / 3, 2 / 3, 1]);
    expect(normalizeValueScores([-2, -1])[0]).toBe(0);
    expect(normalizeValueScores([-2, -1])[1]).toBeCloseTo(1 / 2.001, 10);
  });

  it('counts channels per site', () => {
    expect([...countCandidatesBySite([1, 1, 2, 3, 3, 3]).entries()]).toEqual([
      [1, 2],
      [2, 1],
      [3, 3],
    ]);
  });

  it('normalizes contribution probabilities and handles zero totals', () => {
    expect(normalizeContributions([2, 3, 5])).toEqual([0.2, 0.3, 0.5]);
    expect(normalizeContributions([0, 0])).toEqual([0, 0]);
  });

  it('ranks contributions and delegates exact ties', () => {
    const ranked = rankContributionIndices([0.5, 1, 1], (left, right) => right - left);
    expect(ranked).toEqual([2, 1, 0]);
    expect([...buildContributionRanks(ranked).entries()]).toEqual([
      [2, 1],
      [1, 2],
      [0, 3],
    ]);
  });

  it('selects a weighted index at deterministic random boundaries', () => {
    expect(selectWeightedIndex([], 0.5)).toBeNull();
    expect(selectWeightedIndex([2, 3, 5], 0)).toBe(0);
    expect(selectWeightedIndex([2, 3, 5], 0.21)).toBe(1);
    expect(selectWeightedIndex([2, 3, 5], 0.99)).toBe(2);
  });
});
