import { describe, expect, it } from 'vitest';
import {
  buildCrossPageDropUpdates,
  buildCustomDragReorderUpdates,
  buildCustomReorderUpdates,
  buildUnpinMoveToFrontUpdates,
  canCrossPageDrop,
  sortItemsForDisplay,
  type SortMode,
} from './listSorting.js';

type Item = {
  id: number;
  isPinned?: boolean | null;
  sortOrder?: number | null;
  balance?: number | null;
  status?: string | null;
  healthState?: { state?: string | null } | null;
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

  it('ranks healthy, then all-accounts-disabled, then disabled sites', () => {
    const rows: Item[] = [
      { id: 1, status: 'disabled', sortOrder: 0 },
      { id: 2, status: 'active', sortOrder: 0 },
      { id: 3, status: 'active', sortOrder: 0, healthState: { state: 'disabled' } },
      { id: 4, status: 'active', sortOrder: 0, healthState: { state: 'healthy' } },
    ];
    expect(ids(sortItemsForDisplay(rows, 'custom', () => 0))).toEqual([2, 4, 3, 1]);
  });
});

describe('buildCustomDragReorderUpdates', () => {
  const list: Item[] = [
    { id: 10, isPinned: true, sortOrder: 0, status: 'active' },
    { id: 11, isPinned: true, sortOrder: 1, status: 'active' },
    { id: 20, isPinned: false, sortOrder: 0, status: 'active' },
    { id: 21, isPinned: false, sortOrder: 1, status: 'active' },
    { id: 22, isPinned: false, sortOrder: 2, status: 'active' },
    { id: 30, isPinned: false, sortOrder: 0, status: 'disabled' },
  ];

  it('moves directly to the dropped position and normalizes the group', () => {
    expect(buildCustomDragReorderUpdates(list, 20, 22)).toEqual([
      { id: 21, sortOrder: 0 },
      { id: 22, sortOrder: 1 },
      { id: 20, sortOrder: 2 },
    ]);
  });

  it('does not move across pinned or disabled group boundaries', () => {
    expect(buildCustomDragReorderUpdates(list, 20, 10)).toEqual([]);
    expect(buildCustomDragReorderUpdates(list, 20, 30)).toEqual([]);
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

describe('buildCrossPageDropUpdates', () => {
  // 12 unpinned custom-ordered sites across two pages of 10.
  const twelve: Item[] = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    isPinned: false,
    sortOrder: i,
    status: 'enabled',
  }));

  it('moves the first row of page 2 to the last slot of page 1', () => {
    // Page 2 holds ids 11,12. Dropping id 11 on the "prev page" band lands it on
    // page 1's final slot (index 9), pushing id 10 up to index 10.
    const updates = buildCrossPageDropUpdates(twelve, 11, 'prev', 10, 2);
    const byId = new Map(updates.map((u) => [u.id, u.sortOrder]));
    expect(byId.get(11)).toBe(9);
    expect(byId.get(10)).toBe(10);
  });

  it('moves the last row of page 1 to the first slot of page 2', () => {
    // Page 1 holds ids 1..10. Dropping id 10 on the "next page" band makes it
    // the first row of page 2 (index 10).
    const updates = buildCrossPageDropUpdates(twelve, 10, 'next', 10, 1);
    const byId = new Map(updates.map((u) => [u.id, u.sortOrder]));
    expect(byId.get(10)).toBe(10);
  });

  it('returns no updates when the row is already at the boundary slot', () => {
    expect(buildCrossPageDropUpdates(twelve, 10, 'prev', 10, 2)).toEqual([]);
  });

  it('never crosses a group: a pinned boundary clamps to the group edge', () => {
    // 3 pinned rows occupy indices 0-2; page size 2 puts page 1's last slot at
    // index 1, which belongs to the pinned group, so an unpinned row cannot use
    // that boundary — it stays put instead of jumping into another group.
    const mixed: Item[] = [
      { id: 1, isPinned: true, sortOrder: 0, status: 'enabled' },
      { id: 2, isPinned: true, sortOrder: 1, status: 'enabled' },
      { id: 3, isPinned: true, sortOrder: 2, status: 'enabled' },
      { id: 4, isPinned: false, sortOrder: 0, status: 'enabled' },
      { id: 5, isPinned: false, sortOrder: 1, status: 'enabled' },
      { id: 6, isPinned: false, sortOrder: 2, status: 'enabled' },
      { id: 7, isPinned: false, sortOrder: 3, status: 'enabled' },
    ];
    // Unpinned group occupies sorted indices 3-6, so target index 1 clamps to 3,
    // which is where id 4 already sits.
    expect(buildCrossPageDropUpdates(mixed, 4, 'prev', 4, 2)).toEqual([]);
  });

  it('ignores a bad page size or page number', () => {
    expect(buildCrossPageDropUpdates(twelve, 11, 'prev', 0, 2)).toEqual([]);
    expect(buildCrossPageDropUpdates(twelve, 11, 'prev', 10, 0)).toEqual([]);
  });
});

describe('canCrossPageDrop', () => {
  const twelve: Item[] = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    isPinned: false,
    sortOrder: i,
    status: 'enabled',
  }));

  it('offers both bands from a middle page', () => {
    // 25 rows / 10 per page = 3 pages, so page 2 has neighbours on both sides.
    const threePages: Item[] = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      isPinned: false,
      sortOrder: i,
      status: 'enabled',
    }));
    expect(canCrossPageDrop(threePages, 11, 10, 2)).toEqual({ prev: true, next: true });
  });

  it('offers no next band on the last page', () => {
    expect(canCrossPageDrop(twelve, 11, 10, 2)).toEqual({ prev: true, next: false });
  });

  it('offers only the next band from the first page', () => {
    expect(canCrossPageDrop(twelve, 3, 10, 1)).toEqual({ prev: false, next: true });
  });

  it('offers nothing while no drag is in flight', () => {
    expect(canCrossPageDrop(twelve, null, 10, 2)).toEqual({ prev: false, next: false });
  });

  it('hides the band whose boundary falls outside the active item group', () => {
    // Page size 2: page 1's last slot (index 1) is pinned, so the unpinned row 4
    // must not be offered the "previous page" band.
    const mixed: Item[] = [
      { id: 1, isPinned: true, sortOrder: 0, status: 'enabled' },
      { id: 2, isPinned: true, sortOrder: 1, status: 'enabled' },
      { id: 3, isPinned: false, sortOrder: 0, status: 'enabled' },
      { id: 4, isPinned: false, sortOrder: 1, status: 'enabled' },
      { id: 5, isPinned: false, sortOrder: 2, status: 'enabled' },
      { id: 6, isPinned: false, sortOrder: 3, status: 'enabled' },
    ];
    expect(canCrossPageDrop(mixed, 3, 2, 2)).toEqual({ prev: false, next: true });
  });
});
