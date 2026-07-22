import { useEffect, useMemo, useState } from 'react';
import {
  CLIENT_PAGE_SIZE,
  resolveClientPagination,
} from './clientPagination.js';

/**
 * Client-side pagination for in-memory lists.
 * `resetKey` should change when the filtered list identity changes
 * (segment, sort, search, length, etc.) so the page snaps back to 1.
 */
export function useClientPagination<T>(
  items: T[],
  resetKey?: unknown,
  pageSize: number = CLIENT_PAGE_SIZE,
) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const slice = useMemo(
    () => resolveClientPagination(items.length, page, pageSize),
    [items.length, page, pageSize],
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
