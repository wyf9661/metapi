import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import PageJumpInput from './PageJumpInput.js';
import ModernSelect from './ModernSelect.js';
import { PAGE_SIZE_OPTIONS } from './usePersistedPageSize.js';

type PaginationControlsProps = {
  page: number;
  totalPages: number;
  onPageChange: (nextPage: number | ((current: number) => number)) => void;
  /** When false, render nothing. */
  visible?: boolean;
  style?: CSSProperties;
  className?: string;
  /** Current rows-per-page. When provided, render a page-size selector. */
  pageSize?: number;
  /** Called when the user picks a new rows-per-page. */
  onPageSizeChange?: (next: number) => void;
  /** Optional range summary pinned to the left side of the pagination row. */
  rangeLabel?: string;
};

export default function PaginationControls({
  page,
  totalPages,
  onPageChange,
  visible = true,
  style,
  className = 'pagination',
  pageSize,
  onPageSizeChange,
  rangeLabel,
}: PaginationControlsProps) {
  const pageNumbers = useMemo(() => {
    if (totalPages <= 1) return [];
    const windowSize = Math.min(totalPages, 7);
    return Array.from({ length: windowSize }, (_, i) => {
      if (totalPages <= 7 || page <= 4) return i + 1;
      if (page >= totalPages - 3) return totalPages - windowSize + 1 + i;
      return page - 3 + i;
    });
  }, [page, totalPages]);

  if (!visible) return null;

  const goTo = (nextPage: number) => onPageChange(nextPage);
  const showPageNavigation = totalPages > 1;

  return (
    <div className={className} style={{ marginTop: 12, ...style }}>
      {rangeLabel && <div className="pagination-range">{rangeLabel}</div>}
      {showPageNavigation && (
        <>
          <button
            type="button"
            className="pagination-btn"
            disabled={page <= 1}
            onClick={() => goTo(page - 1)}
          >
            上一页
          </button>
          {pageNumbers.map((n) => (
            <button
              key={n}
              type="button"
              className={`pagination-btn ${page === n ? 'active' : ''}`}
              onClick={() => goTo(n)}
            >
              {n}
            </button>
          ))}
          <span className="pagination-info">
            第 {page} / {totalPages} 页
          </span>
          <PageJumpInput totalPages={totalPages} onJump={goTo} />
          <button
            type="button"
            className="pagination-btn"
            disabled={page >= totalPages}
            onClick={() => goTo(page + 1)}
          >
            下一页
          </button>
        </>
      )}
      {typeof pageSize === 'number' && onPageSizeChange && (
        <div className="pagination-size">
          每页条数:
          <div style={{ minWidth: 86 }}>
            <ModernSelect
              size="sm"
              dropDirection="up"
              value={String(pageSize)}
              onChange={(nextValue) => onPageSizeChange(Number(nextValue))}
              options={PAGE_SIZE_OPTIONS.map((s) => ({
                value: String(s),
                label: String(s),
              }))}
              placeholder={String(pageSize)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
