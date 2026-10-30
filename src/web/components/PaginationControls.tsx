import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import PageJumpInput from './PageJumpInput.js';
import ModernSelect from './ModernSelect.js';
import { MOBILE_PAGE_SIZE_OPTIONS, PAGE_SIZE_OPTIONS } from './usePersistedPageSize.js';
import { useIsMobile } from './useIsMobile.js';
import { tr, useI18nOptional } from '../i18n.js';

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
  onPageSizeChange?: (next: number) => void;
  /** Optional range summary pinned to the left side of the pagination row. */
  rangeLabel?: string;
  /** When set, the component renders the range summary itself in the active language. */
  totalItems?: number;
  /** Override the rows-per-page choices (e.g. a page with a denser default grid). */
  pageSizeOptions?: readonly number[];
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
  totalItems,
  pageSizeOptions: pageSizeOptionsProp,
}: PaginationControlsProps) {
  const language = useI18nOptional()?.language ?? 'zh';
  const isMobile = useIsMobile();
  // 769–1200 的窄桌面同样放不下一整行（信息/跳转/下一页会被挤到第二行），
  // 用同一套紧凑布局：上一页 / 页码 / 下一页 同行对称，其余居中换行。
  // 两个 Hook 都必须无条件调用：在 `||` 右侧短路会让跨 768px 缩放时
  // Hook 数量在两次渲染间变化（"Rendered more/fewer hooks"）。
  const isNarrowViewport = useIsMobile(1200);
  const isCompact = isMobile || isNarrowViewport;
  const defaultPageSizeOptions = isMobile ? MOBILE_PAGE_SIZE_OPTIONS : PAGE_SIZE_OPTIONS;
  const pageSizeOptions = pageSizeOptionsProp && pageSizeOptionsProp.length > 0
    ? pageSizeOptionsProp
    : defaultPageSizeOptions;
  const resolvedRangeLabel = totalItems == null ? rangeLabel : (() => {
    const perPage = pageSize ?? Math.ceil(totalItems / Math.max(1, totalPages));
    const start = totalItems === 0 ? 0 : (page - 1) * perPage + 1;
    const end = Math.min(start + perPage - 1, totalItems);
    return language === 'en'
      ? `Showing ${start} - ${end} of ${totalItems}`
      : `显示第 ${start} - ${end} 条，共 ${totalItems} 条`;
  })();
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
  // The numeric window slides away from page 1 on deep pages, so reaching the
  // first page otherwise means clicking "上一页" repeatedly. Offer it only
  // when it is not already a numbered button — never duplicate a page.
  const firstPageOutsideWindow = pageNumbers.length > 0 && !pageNumbers.includes(1);

  const pageSizeControl = typeof pageSize === 'number' && onPageSizeChange ? (
    <div className="pagination-size">{tr('每页条数:')}<div style={{ minWidth: 86 }}>
        <ModernSelect
          size="sm"
          dropDirection="up"
          value={String(pageSize)}
          onChange={(nextValue) => onPageSizeChange(Number(nextValue))}
          options={pageSizeOptions.map((s) => ({
            value: String(s),
            label: String(s),
          }))}
          placeholder={String(pageSize)}
        />
      </div>
    </div>
  ) : null;

  // Mobile: 上一页 / 页码信息 / 下一页 必须同行、左右等宽对称；页码单独一行居中，
  // 跳转与每页条数放最后一行居中。此前全部平铺 + flex-wrap，导致「下一页」跑到
  // 跳转输入框右侧、页码信息整行贴左（inline-flex 下 text-align 不生效）。
  if (isCompact) {
    return (
      <div className={`${className} pagination-compact`} style={style}>
        {resolvedRangeLabel && <div className="pagination-range">{resolvedRangeLabel}</div>}
        {showPageNavigation && (
          <>
            <div className="pagination-compact-nav">
              <button
                type="button"
                className="pagination-btn"
                disabled={page <= 1}
                onClick={() => goTo(page - 1)}
              >{tr('上一页')}</button>
              <span className="pagination-info">
                {language === 'en' ? `Page ${page} / ${totalPages}` : <>第 {page} / {totalPages} 页</>}
              </span>
              <button
                type="button"
                className="pagination-btn"
                disabled={page >= totalPages}
                onClick={() => goTo(page + 1)}
              >{tr('下一页')}</button>
            </div>
            <div className="pagination-compact-numbers">
              {firstPageOutsideWindow && (
                <button
                  type="button"
                  className="pagination-btn"
                  onClick={() => goTo(1)}
                  aria-label={tr('回到第一页')}
                  title={tr('回到第一页')}
                >{tr('首页')}</button>
              )}
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
            </div>
          </>
        )}
        {(showPageNavigation || pageSizeControl) && (
          <div className="pagination-compact-extra">
            {showPageNavigation && <PageJumpInput totalPages={totalPages} onJump={goTo} />}
            {pageSizeControl}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={className} style={style}>
      {resolvedRangeLabel && <div className="pagination-range">{resolvedRangeLabel}</div>}
      {showPageNavigation && (
        <>
          <button
            type="button"
            className="pagination-btn"
            disabled={page <= 1}
            onClick={() => goTo(page - 1)}
          >{tr('上一页')}</button>
          {firstPageOutsideWindow && (
            <button
              type="button"
              className="pagination-btn"
              onClick={() => goTo(1)}
              aria-label={tr('回到第一页')}
              title={tr('回到第一页')}
            >{tr('首页')}</button>
          )}
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
            {language === 'en' ? `Page ${page} / ${totalPages}` : <>第 {page} / {totalPages} 页</>}
          </span>
          <PageJumpInput totalPages={totalPages} onJump={goTo} />
          <button
            type="button"
            className="pagination-btn"
            disabled={page >= totalPages}
            onClick={() => goTo(page + 1)}
          >{tr('下一页')}</button>
        </>
      )}
      {pageSizeControl}
    </div>
  );
}
