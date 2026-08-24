import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  CLIENT_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  resolveClientPagination,
  snapToPageSizeOptions,
} from './clientPagination.js';

/**
 * Estimate a reasonable page size from the viewport height. Used ONLY to pick
 * the initial value once on first render — there is no dynamic re-measuring,
 * so the layout stays stable (no row-count jump, no scrollbar flip jitter).
 *
 * Falls back to DEFAULT_PAGE_SIZE when dimensions are unavailable (SSR/tests).
 * The result is always snapped to a legal PAGE_SIZE_OPTIONS entry.
 */
export function estimateClientPageSize(
  current: number = CLIENT_PAGE_SIZE,
  min: number = 4,
  max: number = 30,
  rowHeight: number = 52,
): number {
  if (typeof window === 'undefined') return snapToPageSizeOptions(current);
  const viewportH = window.innerHeight;
  if (!Number.isFinite(viewportH) || viewportH <= 0) return snapToPageSizeOptions(current);
  const topbarH = 64;
  const chromeH = 180; // page header, filters, pagination bar, breathing room
  const usable = viewportH - topbarH - chromeH;
  if (usable <= rowHeight * min) return snapToPageSizeOptions(min);
  const rows = Math.floor(usable / rowHeight);
  return snapToPageSizeOptions(Math.min(max, Math.max(min, rows)));
}

/**
 * A stable, user-controllable page size. The initial value is estimated once
 * from the viewport on first render, then the user can switch between 5/10/20/50
 * via `setPageSize`. No ResizeObserver, no resize listeners, no re-measuring —
 * the paged layout never changes under the user except when they ask for it.
 *
 * Returns `[pageSize, setPageSize]`; `setPageSize` accepts any number and snaps
 * it to the nearest legal option.
 */
export function useSelectablePageSize(
  initialSize: number = DEFAULT_PAGE_SIZE,
): [number, Dispatch<SetStateAction<number>>] {
  const [pageSize, setPageSize] = useState<number>(() =>
    snapToPageSizeOptions(estimateClientPageSize(initialSize)),
  );

  const snapSetter: Dispatch<SetStateAction<number>> = (value) => {
    setPageSize((prev) =>
      snapToPageSizeOptions(typeof value === 'function' ? value(prev) : value),
    );
  };

  return [pageSize, snapSetter];
}

/**
 * @deprecated Replaced by {@link useSelectablePageSize}. Kept as a thin alias
 * so callers migrate incrementally. Returns `[pageSize, setPageSize]`, but WITHOUT
 * any measurement/observer logic — sizing is purely user-selectable.
 */
export function useExactPageSize(): [number, Dispatch<SetStateAction<number>>] {
  return useSelectablePageSize(DEFAULT_PAGE_SIZE);
}

/**
 * @deprecated Replaced by {@link useSelectablePageSize}. Same as
 * useExactPageSize but accepts refs for signature compatibility. The
 * refs are ignored — sizing is now purely user-selectable, never DOM-measured.
 */
export function useExactPageSizeMulti(
  _refs?: unknown[],
  _opts?: { min?: number; max?: number; rowSelector?: string; bottomReserve?: number },
): [number, Dispatch<SetStateAction<number>>] {
  return useSelectablePageSize(DEFAULT_PAGE_SIZE);
}

/**
 * Client-side pagination for in-memory lists.
 * `resetKey` should change when the filtered list identity changes
 * (segment, sort, search, length, etc.) so the page snaps back to 1.
 */
export function useClientPagination<T>(
  items: T[],
  resetKey?: unknown,
  pageSize?: number,
) {
  const resolvedPageSize = pageSize && pageSize > 0 ? pageSize : CLIENT_PAGE_SIZE;
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [resetKey, resolvedPageSize]);

  const slice = useMemo(
    () => resolveClientPagination(items.length, page, resolvedPageSize),
    [items.length, page, resolvedPageSize],
  );

  const pagedItems = useMemo(
    () => items.slice(slice.start, slice.end),
    [items, slice.start, slice.end],
  );

  return {
    page: slice.safePage,
    setPage,
    totalPages: slice.totalPages,
    pageSize: slice.pageSize,
    pagedItems,
    showControls: items.length > slice.pageSize,
  };
}

export { PAGE_SIZE_OPTIONS };