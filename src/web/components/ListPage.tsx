import type { CSSProperties, ReactNode } from 'react';

const DEFAULT_ICON_PATH = 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V19a2 2 0 01-2 2z';

// Shared list page chrome: header, optional stats/filters, bordered list
// card, loading skeleton, empty state and pagination footer. Pages pass
// only the list itself as `children`.
export default function ListPage({
  className,
  style,
  title,
  subtitle,
  actions,
  beforeList,
  children,
  loading = false,
  loadingFallback,
  isEmpty = false,
  emptyTitle,
  emptyDesc,
  pagination,
  cardStyle,
  iconPath = DEFAULT_ICON_PATH,
}: {
  className?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  beforeList?: ReactNode;
  children: ReactNode;
  loading?: boolean;
  loadingFallback?: ReactNode;
  isEmpty?: boolean;
  emptyTitle: string;
  emptyDesc?: ReactNode;
  pagination?: ReactNode;
  cardStyle?: CSSProperties;
  iconPath?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`animate-fade-in${className ? ` ${className}` : ''}`} style={style}>
      <div className="page-header">
        <div>
          <h2 className="page-title">{title}</h2>
          {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>

      {beforeList}

      <div className="card" style={{ overflowX: 'auto', ...cardStyle }}>
        {loading ? (
          loadingFallback ?? (
            <div style={{ padding: 20 }}>
              <div className="skeleton" style={{ width: '100%', height: 34, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: '100%', height: 34, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: '100%', height: 34 }} />
            </div>
          )
        ) : isEmpty ? (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d={iconPath} />
            </svg>
            <div className="empty-state-title">{emptyTitle}</div>
            {emptyDesc ? <div className="empty-state-desc">{emptyDesc}</div> : null}
          </div>
        ) : (
          children
        )}
      </div>

      {pagination}
    </div>
  );
}
