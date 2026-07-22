/** Shared client-side page size for Sites / Accounts / Tokens tables. */
export const CLIENT_PAGE_SIZE = 8;

export type ClientPaginationSlice = {
  pageSize: number;
  totalPages: number;
  safePage: number;
  start: number;
  end: number;
};

export function resolveClientPagination(
  totalItems: number,
  page: number,
  pageSize: number = CLIENT_PAGE_SIZE,
): ClientPaginationSlice {
  const normalizedSize = Math.max(1, Math.trunc(pageSize) || CLIENT_PAGE_SIZE);
  const count = Math.max(0, Math.trunc(totalItems) || 0);
  const totalPages = Math.max(1, Math.ceil(count / normalizedSize));
  const requested = Math.trunc(page);
  const safePage = Number.isFinite(requested)
    ? Math.min(Math.max(1, requested), totalPages)
    : 1;
  const start = (safePage - 1) * normalizedSize;
  return {
    pageSize: normalizedSize,
    totalPages,
    safePage,
    start,
    end: start + normalizedSize,
  };
}

/** 1-based page that contains the 0-based item index. */
export function pageForItemIndex(
  index: number,
  pageSize: number = CLIENT_PAGE_SIZE,
): number {
  if (!Number.isFinite(index) || index < 0) return 1;
  const normalizedSize = Math.max(1, Math.trunc(pageSize) || CLIENT_PAGE_SIZE);
  return Math.floor(index / normalizedSize) + 1;
}
