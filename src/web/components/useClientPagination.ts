import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
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
 * Measure the exact number of table rows that fit between the table container
 * and the bottom of the viewport, so the last row lands flush without a
 * scrollbar and without overflowing.
 *
 * `tableRef` should point at the table (or its wrapping container). The row
 * height is taken from the first rendered row (`rowSelector`), defaulting to
 * the `.data-table tbody tr` height.
 */
export function useExactPageSize<T extends HTMLElement>(
  tableRef: RefObject<T | null>,
  opts: { min?: number; max?: number; rowSelector?: string; bottomReserve?: number } = {},
): number {
  const min = opts.min ?? 4;
  const max = opts.max ?? 30;
  const rowSelector = opts.rowSelector ?? 'tbody tr';
  const bottomReserve = opts.bottomReserve ?? 56; // pagination bar + breathing room
  const [pageSize, setPageSize] = useState(CLIENT_PAGE_SIZE);

  useEffect(() => {
    const recompute = () => {
      const table = tableRef.current;
      if (!table || typeof window === 'undefined') return;
      const rows = table.querySelectorAll<HTMLElement>(rowSelector);
      const firstRow = rows[0];
      if (!firstRow) return;
      const rowHeight = firstRow.getBoundingClientRect().height;
      if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;

      const tableTop = table.getBoundingClientRect().top;
      const available = window.innerHeight - tableTop - bottomReserve;
      if (available <= rowHeight * min) {
        setPageSize(min);
        return;
      }
      const rowsThatFit = Math.floor(available / rowHeight);
      setPageSize(Math.min(max, Math.max(min, rowsThatFit)));
    };

    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [tableRef, rowSelector, min, max, bottomReserve]);

  return pageSize;
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
