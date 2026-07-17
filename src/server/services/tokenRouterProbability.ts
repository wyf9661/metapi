export function normalizeValueScores(values: number[]): number[] {
  if (values.length === 0) return [];
  const maxValue = Math.max(...values, 0.001);
  const minValue = Math.min(...values, 0);
  const range = maxValue - minValue || 1;
  return values.map((value) => (value - minValue) / range);
}

export function countCandidatesBySite(siteIds: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const siteId of siteIds) {
    counts.set(siteId, (counts.get(siteId) || 0) + 1);
  }
  return counts;
}

export function normalizeContributions(contributions: number[]): number[] {
  const total = contributions.reduce((sum, contribution) => sum + contribution, 0);
  return contributions.map((contribution) => (total > 0 ? contribution / total : 0));
}

export function rankContributionIndices(
  contributions: number[],
  compareTies: (leftIndex: number, rightIndex: number) => number,
): number[] {
  return contributions.map((_, index) => index)
    .sort((leftIndex, rightIndex) => {
      const contributionDiff = contributions[rightIndex]! - contributions[leftIndex]!;
      if (Math.abs(contributionDiff) > 1e-9) {
        return contributionDiff > 0 ? 1 : -1;
      }
      return compareTies(leftIndex, rightIndex);
    });
}

export function buildContributionRanks(rankedIndices: number[]): Map<number, number> {
  const ranks = new Map<number, number>();
  rankedIndices.forEach((candidateIndex, rank) => {
    ranks.set(candidateIndex, rank + 1);
  });
  return ranks;
}

export function selectWeightedIndex(contributions: number[], randomUnit = Math.random()): number | null {
  if (contributions.length === 0) return null;
  const total = contributions.reduce((sum, contribution) => sum + contribution, 0);
  let remaining = randomUnit * total;
  let selectedIndex = contributions.length - 1;
  for (let index = 0; index < contributions.length; index += 1) {
    remaining -= contributions[index]!;
    if (remaining <= 0) {
      selectedIndex = index;
      break;
    }
  }
  return selectedIndex;
}
