import { useEffect, useMemo, useState } from 'react';
import {
  CLIENT_PAGE_SIZE,
  resolveClientPagination,
} from './clientPagination.js';

/**
 * Estimate a client-side page size from the viewport height so tall screens
 * show more rows per page instead of forcing an 8-row page by default.
 *
 * Falls back to CLIENT_PAGE_SIZE when dimensions are unavailable (SSR/tests).
 */
export function estimateClientPageSize(
  current: number = CLIENT_PAGE_SIZE,
  min: number = 6,
  max: number = 24,
  rowHeight: number = 52,
): number {
  if (typeof window === 'undefined') return current;
  const viewportH = window.innerHeight;
  if (!Number.isFinite(viewportH) || viewportH <= 0) return current;
  const topbarH = 64;
  const chromeH = 180; // page header, filters, pagination bar, breathing room
  const usable = viewportH - topbarH - chromeH;
  if (usable <= rowHeight * min) return min;
  const rows = Math.floor(usable / rowHeight);
  return Math.min(max, Math.max(min, rows));
}

export function useViewportPageSize(
  base: number = CLIENT_PAGE_SIZE,
  min?: number,
  max?: number,
): { pageSize: number; rowHeight: number } {
  const [viewport, setViewport] = useState(() => ({
    pageSize: estimateClientPageSize(base, min, max),
    rowHeight: 52,
  }));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const recompute = () =>
      setViewport({
        pageSize: estimateClientPageSize(base, min, max),
        rowHeight: 52,
      });
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [base, min, max]);

  return viewport;
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
