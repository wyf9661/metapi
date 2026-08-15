import { describe, expect, it } from 'vitest';
import { selectWithBoundedGap } from './boundedGapSelection.js';

describe('selectWithBoundedGap', () => {
  it('keeps weighted selection while preventing a low-probability candidate from starving', () => {
    const states = [
      { sequence: 0, lastSelectedSequence: null },
      { sequence: 0, lastSelectedSequence: null },
    ];
    const scores = [99, 1];
    let selected = -1;
    for (let i = 0; i < 100; i += 1) {
      const result = selectWithBoundedGap(scores, states, 0);
      expect(result).not.toBeNull();
      selected = result!.selectedIndex;
    }
    expect(selected).toBe(1);
    expect(states[1].lastSelectedSequence).toBe(100);
  });

  it('does not force an unavailable zero-score candidate', () => {
    const states = [
      { sequence: 0, lastSelectedSequence: null },
      { sequence: 0, lastSelectedSequence: null },
    ];
    const result = selectWithBoundedGap([1, 0], states, 0.99);
    expect(result?.selectedIndex).toBe(0);
    expect(result?.forced).toBe(true);
  });
});
