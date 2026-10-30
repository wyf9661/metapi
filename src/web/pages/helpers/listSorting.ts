export type SortMode = 'custom' | 'balance-desc' | 'balance-asc';

type SortableBase = {
  id: number;
  isPinned?: boolean | null;
  sortOrder?: number | null;
  status?: string | null;
  healthState?: { state?: string | null } | null;
};

// Sites rank by availability: healthy first, then sites whose accounts are all
// disabled (the site itself is still enabled), then disabled sites. Without the
// middle tier a site with every account disabled sat among the healthy ones.
function availabilityRank(item: SortableBase): number {
  if (item.status === 'disabled') return 2;
  if (item.healthState?.state === 'disabled') return 1;
  return 0;
}

export function sortItemsForDisplay<T extends SortableBase>(
  items: T[],
  mode: SortMode,
  getBalance: (item: T) => number,
): T[] {
  const list = [...items];
  const customComparator = (a: T, b: T) => {
    const aPinned = a.isPinned ? 1 : 0;
    const bPinned = b.isPinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;

    // 在默认排序下, 可用性差的排到最后: 账号全禁用 > 站点禁用
    const aRank = availabilityRank(a);
    const bRank = availabilityRank(b);
    if (aRank !== bRank) return aRank - bRank;

    const aOrder = Number.isFinite(a.sortOrder as number) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
    const bOrder = Number.isFinite(b.sortOrder as number) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.id - b.id;
  };

  if (mode === 'custom') {
    return list.sort(customComparator);
  }

  return list.sort((a, b) => {
    const aPinned = a.isPinned ? 1 : 0;
    const bPinned = b.isPinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;

    const aBalance = Number.isFinite(getBalance(a)) ? getBalance(a) : 0;
    const bBalance = Number.isFinite(getBalance(b)) ? getBalance(b) : 0;
    if (aBalance !== bBalance) {
      return mode === 'balance-desc' ? bBalance - aBalance : aBalance - bBalance;
    }

    return customComparator(a, b);
  });
}

export function buildCustomReorderUpdates<T extends SortableBase>(
  items: T[],
  targetId: number,
  direction: 'up' | 'down',
): Array<{ id: number; sortOrder: number }> {
  const sorted = sortItemsForDisplay(items, 'custom', () => 0);
  const target = sorted.find((item) => item.id === targetId);
  if (!target) return [];

  const targetPinned = !!target.isPinned;
  const group = sorted.filter((item) => !!item.isPinned === targetPinned);
  const index = group.findIndex((item) => item.id === targetId);
  if (index < 0) return [];

  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= group.length) return [];

  const next = [...group];
  const temp = next[index];
  next[index] = next[swapIndex];
  next[swapIndex] = temp;

  const updates: Array<{ id: number; sortOrder: number }> = [];
  next.forEach((item, idx) => {
    const prev = Number.isFinite(item.sortOrder as number) ? Number(item.sortOrder) : Number.MAX_SAFE_INTEGER;
    if (prev !== idx) {
      updates.push({ id: item.id, sortOrder: idx });
    }
  });

  return updates;
}

export function buildCustomDragReorderUpdates<T extends SortableBase>(
  items: T[],
  activeId: number,
  overId: number,
): Array<{ id: number; sortOrder: number }> {
  if (activeId === overId) return [];

  const sorted = sortItemsForDisplay(items, 'custom', () => 0);
  const active = sorted.find((item) => item.id === activeId);
  const over = sorted.find((item) => item.id === overId);
  if (!active || !over) return [];

  const activeDisabled = active.status === 'disabled';
  if (!!active.isPinned !== !!over.isPinned || activeDisabled !== (over.status === 'disabled')) {
    return [];
  }

  const group = sorted.filter((item) => (
    !!item.isPinned === !!active.isPinned
    && (item.status === 'disabled') === activeDisabled
  ));
  const activeIndex = group.findIndex((item) => item.id === activeId);
  const overIndex = group.findIndex((item) => item.id === overId);
  if (activeIndex < 0 || overIndex < 0) return [];

  const next = [...group];
  const [moved] = next.splice(activeIndex, 1);
  next.splice(overIndex, 0, moved);

  return next.flatMap((item, index) => {
    const previous = Number.isFinite(item.sortOrder as number)
      ? Number(item.sortOrder)
      : Number.MAX_SAFE_INTEGER;
    return previous === index ? [] : [{ id: item.id, sortOrder: index }];
  });
}

/**
 * Cross-page move: drop the active item on the band at the top/bottom of the
 * current page, landing it on the adjacent page's far edge.
 *
 * `page` is 1-based and `pageSize` is the rendered page size, so the two
 * targets are ordinary positions in the full list:
 *   - 'prev' → the LAST slot of the previous page  = (page - 1) * pageSize - 1
 *   - 'next' → the FIRST slot of the next page     = page * pageSize
 * Both reduce to "the active item's final index in the full list", which is also
 * its insertion index in the group (removing the active item shifts nothing
 * across that index).
 *
 * The move is clamped into the active item's own group (pinned / normal /
 * disabled are contiguous ranges and never mix), so a boundary that falls in a
 * different group lands on that group's nearest edge instead of crossing it.
 */
export function buildCrossPageDropUpdates<T extends SortableBase>(
  items: T[],
  activeId: number,
  direction: 'prev' | 'next',
  pageSize: number,
  page: number,
): Array<{ id: number; sortOrder: number }> {
  if (!Number.isFinite(pageSize) || pageSize <= 0 || !Number.isFinite(page) || page < 1) return [];

  const sorted = sortItemsForDisplay(items, 'custom', () => 0);
  const active = sorted.find((item) => item.id === activeId);
  if (!active) return [];

  const activeDisabled = active.status === 'disabled';
  const group = sorted.filter((item) => (
    !!item.isPinned === !!active.isPinned
    && (item.status === 'disabled') === activeDisabled
  ));
  const activeIndex = group.findIndex((item) => item.id === activeId);
  if (activeIndex < 0) return [];

  const groupStart = sorted.findIndex((item) => item.id === group[0]?.id);
  if (groupStart < 0) return [];

  const targetAbsolute = direction === 'prev'
    ? (page - 1) * pageSize - 1
    : page * pageSize;
  const desiredIndex = Math.max(0, Math.min(group.length - 1, targetAbsolute - groupStart));
  if (desiredIndex === activeIndex) return [];

  const next = [...group];
  const [moved] = next.splice(activeIndex, 1);
  next.splice(desiredIndex, 0, moved);

  return next.flatMap((item, index) => {
    const previous = Number.isFinite(item.sortOrder as number)
      ? Number(item.sortOrder)
      : Number.MAX_SAFE_INTEGER;
    return previous === index ? [] : [{ id: item.id, sortOrder: index }];
  });
}

/**
 * Which cross-page bands the active item may actually use. A band is offered
 * only when the adjacent page's boundary slot falls inside the active item's own
 * group (pinned / normal / disabled are contiguous and never mix), so the UI
 * never advertises a drop the reorder would have to clamp.
 */
export function canCrossPageDrop<T extends SortableBase>(
  items: T[],
  activeId: number | null,
  pageSize: number,
  page: number,
): { prev: boolean; next: boolean } {
  const none = { prev: false, next: false };
  if (activeId == null || !Number.isFinite(pageSize) || pageSize <= 0 || !Number.isFinite(page) || page < 1) {
    return none;
  }

  const sorted = sortItemsForDisplay(items, 'custom', () => 0);
  const active = sorted.find((item) => item.id === activeId);
  if (!active) return none;

  const activeDisabled = active.status === 'disabled';
  const indexOf = new Map(sorted.map((item, index) => [item.id, index]));
  const activeIndex = indexOf.get(activeId) ?? -1;
  if (activeIndex < 0) return none;

  const groupIndices = sorted
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (
      !!item.isPinned === !!active.isPinned
      && (item.status === 'disabled') === activeDisabled
    ))
    .map(({ index }) => index);
  const min = Math.min(...groupIndices);
  const max = Math.max(...groupIndices);

  const prevTarget = (page - 1) * pageSize - 1;
  const nextTarget = page * pageSize;
  return {
    prev: page > 1 && prevTarget >= min && prevTarget <= max && prevTarget !== activeIndex,
    next: nextTarget >= min && nextTarget <= max && nextTarget !== activeIndex,
  };
}

/**
 * When unpinning an item, place it at the front of the unpinned group
 * (sortOrder=0) and shift all existing unpinned items down by one so the
 * item stays at the top position instead of jumping back to its original
 * position.
 */
export function buildUnpinMoveToFrontUpdates<T extends SortableBase>(
  items: T[],
  targetId: number,
): Array<{ id: number; sortOrder: number }> {
  const sorted = sortItemsForDisplay(items, 'custom', () => 0);
  const target = sorted.find((item) => item.id === targetId);
  if (!target || !target.isPinned) return [];

  const unpinned = sorted.filter((item) => !item.isPinned);
  if (unpinned.length === 0) return [];

  const updates: Array<{ id: number; sortOrder: number }> = [];
  unpinned.forEach((item, idx) => {
    const newOrder = idx + 1; // Shift down by 1 (index 0 is taken by the target)
    const prev = Number.isFinite(item.sortOrder as number) ? Number(item.sortOrder) : Number.MAX_SAFE_INTEGER;
    if (prev !== newOrder) {
      updates.push({ id: item.id, sortOrder: newOrder });
    }
  });
  return updates;
}
