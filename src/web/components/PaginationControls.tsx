import type { CSSProperties } from 'react';

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
  if (!visible || totalPages <= 1) return null;

  return (
    <div className={className} style={{ marginTop: 12, ...style }}>
      <button
        type="button"
        className="pagination-btn"
        disabled={page <= 1}
        onClick={() => onPageChange((current) => current - 1)}
      >
        上一页
      </button>
      <span>
        第 {page} / {totalPages} 页
      </span>
      <button
        type="button"
        className="pagination-btn"
        disabled={page >= totalPages}
        onClick={() => onPageChange((current) => current + 1)}
      >
        下一页
      </button>
    </div>
  );
}
