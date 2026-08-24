/** Shared client-side page size for Sites / Accounts / Tokens tables. */
export const CLIENT_PAGE_SIZE = 8;

/** Pre-set choices users can pick for rows-per-page. */
export const PAGE_SIZE_OPTIONS = [5, 10, 20, 50] as const;

/** Default rows-per-page when the user hasn't chosen yet. */
export const DEFAULT_PAGE_SIZE = 10;

/** Snap an arbitrary row count to the nearest legal PAGE_SIZE_OPTIONS entry. */
export function snapToPageSizeOptions(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PAGE_SIZE;
  let best = DEFAULT_PAGE_SIZE;
  let bestDist = Infinity;
  for (const opt of PAGE_SIZE_OPTIONS) {
    const d = Math.abs(opt - value);
    if (d < bestDist) {
      bestDist = d;
      best = opt;
    }
  }
  return best;
}

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
