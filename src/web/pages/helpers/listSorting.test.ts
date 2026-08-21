import { describe, expect, it } from 'vitest';
import { buildCustomReorderUpdates, buildUnpinMoveToFrontUpdates, sortItemsForDisplay, type SortMode } from './listSorting.js';

type Item = {
  id: number;
  isPinned?: boolean | null;
  sortOrder?: number | null;
  balance?: number | null;
};

function ids(items: Item[]): number[] {
  return items.map((item) => item.id);
}

describe('sortItemsForDisplay', () => {
  const base: Item[] = [
    { id: 1, isPinned: false, sortOrder: 2, balance: 5 },
    { id: 2, isPinned: true, sortOrder: 1, balance: 1 },
    { id: 3, isPinned: false, sortOrder: 0, balance: 20 },
    { id: 4, isPinned: true, sortOrder: 0, balance: 10 },
  ];

  it('keeps pinned items first in custom mode', () => {
    const mode: SortMode = 'custom';
    const sorted = sortItemsForDisplay(base, mode, (item) => item.balance || 0);
    expect(ids(sorted)).toEqual([4, 2, 3, 1]);
  });

  it('sorts by balance desc while keeping pinned items first', () => {
    const sorted = sortItemsForDisplay(base, 'balance-desc', (item) => item.balance || 0);
    expect(ids(sorted)).toEqual([4, 2, 3, 1]);
  });

  it('sorts by balance asc while keeping pinned items first', () => {
    const sorted = sortItemsForDisplay(base, 'balance-asc', (item) => item.balance || 0);
    expect(ids(sorted)).toEqual([2, 4, 1, 3]);
  });
});

describe('buildCustomReorderUpdates', () => {
  const list: Item[] = [
    { id: 10, isPinned: true, sortOrder: 0 },
    { id: 11, isPinned: true, sortOrder: 1 },
    { id: 20, isPinned: false, sortOrder: 0 },
    { id: 21, isPinned: false, sortOrder: 1 },
  ];

  it('reorders only inside the same pinned group', () => {
    const updates = buildCustomReorderUpdates(list, 20, 'up');
    // First unpinned item cannot move above pinned group.
    expect(updates).toEqual([]);
  });

  it('returns normalized sortOrder updates after moving down', () => {
    const updates = buildCustomReorderUpdates(list, 20, 'down');
    expect(updates).toEqual([
      { id: 21, sortOrder: 0 },
      { id: 20, sortOrder: 1 },
    ]);
  });
});

describe('buildUnpinMoveToFrontUpdates', () => {
  const list: Item[] = [
    { id: 1, isPinned: true, sortOrder: 0 },
    { id: 2, isPinned: true, sortOrder: 1 },
    { id: 10, isPinned: false, sortOrder: 0 },
    { id: 11, isPinned: false, sortOrder: 1 },
    { id: 12, isPinned: false, sortOrder: 2 },
  ];

  it('shifts existing unpinned items down by one when unpinning a pinned item', () => {
    const updates = buildUnpinMoveToFrontUpdates(list, 1);
    // Id 1 (pinned) is being unpinned → takes sortOrder 0, existing unpinned
    // items shift down: 10→1, 11→2, 12→3
    expect(updates).toEqual([
      { id: 10, sortOrder: 1 },
      { id: 11, sortOrder: 2 },
      { id: 12, sortOrder: 3 },
    ]);
  });

  it('returns empty when target is already unpinned', () => {
    const updates = buildUnpinMoveToFrontUpdates(list, 10);
    expect(updates).toEqual([]);
  });

  it('returns empty when target does not exist', () => {
    const updates = buildUnpinMoveToFrontUpdates(list, 999);
    expect(updates).toEqual([]);
  });

  it('returns empty when there are no unpinned items', () => {
    const allPinned: Item[] = [
      { id: 1, isPinned: true, sortOrder: 0 },
      { id: 2, isPinned: true, sortOrder: 1 },
    ];
    const updates = buildUnpinMoveToFrontUpdates(allPinned, 1);
    expect(updates).toEqual([]);
  });

  it('skips updates for items whose sortOrder already matches the new order', () => {
    // If unpinned items already have sortOrder 1,2,3 (instead of 0,1,2),
    // shifting them to 1,2,3 is a no-op for the first two.
    const offsetList: Item[] = [
      { id: 1, isPinned: true, sortOrder: 0 },
      { id: 10, isPinned: false, sortOrder: 1 },
      { id: 11, isPinned: false, sortOrder: 2 },
      { id: 12, isPinned: false, sortOrder: 3 },
    ];
    const updates = buildUnpinMoveToFrontUpdates(offsetList, 1);
    // 10→1 (already 1, skip), 11→2 (already 2, skip), 12→3 (already 3, skip)
    expect(updates).toEqual([]);
  });
});
