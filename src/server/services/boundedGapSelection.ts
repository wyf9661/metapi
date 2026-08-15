export type BoundedGapState = {
  sequence: number;
  lastSelectedSequence: number | null;
};

export type BoundedGapSelection = {
  selectedIndex: number;
  forced: boolean;
  maxGap: number;
};

/**
 * Weighted selection with a hard maximum gap for every positive-score candidate.
 * The state is intentionally supplied by the caller so the policy can be kept
 * separate from routing/health decisions.
 */
export function selectWithBoundedGap(
  scores: number[],
  states: BoundedGapState[],
  randomUnit = Math.random(),
): BoundedGapSelection | null {
  if (scores.length === 0 || scores.length !== states.length) return null;
  const total = scores.reduce((sum, score) => sum + (Number.isFinite(score) && score > 0 ? score : 0), 0);
  if (total <= 0) return null;

  const sequence = Math.max(...states.map((state) => state.sequence), 0) + 1;
  for (const state of states) state.sequence = sequence;

  let dueIndex = -1;
  let dueUrgency = -Infinity;
  let dueMaxGap = 0;
  for (let index = 0; index < scores.length; index += 1) {
    const score = scores[index] ?? 0;
    if (!(score > 0) || !Number.isFinite(score)) continue;
    const probability = score / total;
    const maxGap = Math.max(1, Math.ceil(1 / probability));
    const age = states[index]?.lastSelectedSequence == null
      ? sequence
      : sequence - (states[index]?.lastSelectedSequence ?? sequence);
    if (age < maxGap) continue;
    const urgency = age / maxGap;
    if (urgency > dueUrgency) {
      dueIndex = index;
      dueUrgency = urgency;
      dueMaxGap = maxGap;
    }
  }

  let selectedIndex = dueIndex;
  if (selectedIndex < 0) {
    let remaining = Math.min(1, Math.max(0, randomUnit)) * total;
    selectedIndex = scores.length - 1;
    for (let index = 0; index < scores.length; index += 1) {
      remaining -= Math.max(0, scores[index] ?? 0);
      if (remaining <= 0) {
        selectedIndex = index;
        break;
      }
    }
  }

  const selectedState = states[selectedIndex];
  if (!selectedState) return null;
  selectedState.lastSelectedSequence = sequence;
  const selectedScore = Math.max(0, scores[selectedIndex] ?? 0);
  return {
    selectedIndex,
    forced: dueIndex >= 0,
    maxGap: dueIndex >= 0 ? dueMaxGap : Math.max(1, Math.ceil(total / Math.max(selectedScore, 1e-12))),
  };
}
