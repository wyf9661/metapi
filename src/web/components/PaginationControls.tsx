import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import PageJumpInput from './PageJumpInput.js';

type PaginationControlsProps = {
  page: number;
  totalPages: number;
  onPageChange: (nextPage: number | ((current: number) => number)) => void;
  /** When false, render nothing (caller already knows list fits one page). */
  visible?: boolean;
  style?: CSSProperties;
  className?: string;
};

export default function PaginationControls({
  page,
  totalPages,
  onPageChange,
  visible = true,
  style,
  className = 'pagination',
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

  if (!visible || totalPages <= 1) return null;

  const goTo = (nextPage: number) => onPageChange(nextPage);

  return (
    <div className={className} style={{ marginTop: 12, ...style }}>
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
      <span
        className="pagination-info"
        style={{
          width: 'auto',
          margin: '0 4px',
          fontSize: 13,
          color: 'var(--color-text-muted)',
          whiteSpace: 'nowrap',
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
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
    </div>
  );
}