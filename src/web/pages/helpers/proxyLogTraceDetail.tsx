/**
 * Debug-trace detail render helpers for the proxy logs page. Extracted from
 * ProxyLogs.tsx (which was ~3k lines) — pure move, zero behavior change.
 * These are display-only: the copy handler is injected so the module stays
 * free of page state. Types are declared locally to avoid a circular import
 * with ProxyLogs.tsx.
 */
import { DetailDisclosureCard, debugCodeBlockStyle } from './proxyLogsUi.js';
import { parseStoredDebugPreview } from './proxyLogsHelpers.js';

export type ProxyDebugTraceListItemLike = {
  id: number;
  finalStatus?: string | null;
};

export function renderTraceStatusBadge(trace: ProxyDebugTraceListItemLike) {
  const failed = trace.finalStatus === 'failed';
  return (
    <span
      className={`badge ${failed ? 'badge-error' : 'badge-success'}`}
      style={{ fontSize: 11 }}
    >
      {failed ? '失败' : '成功'}
    </span>
  );
}

export function renderStoredDebugDetails(
  title: string,
  value: unknown,
  options: { defaultOpen?: boolean; copyLabel?: string },
  onCopy: (label: string, value: unknown) => void,
) {
  const normalized = parseStoredDebugPreview(value);
  const copyLabel = options?.copyLabel || title;

  return (
    <DetailDisclosureCard title={title} defaultOpen={options?.defaultOpen}>
      <div style={{ padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{
              border: '1px solid var(--color-border)',
              padding: '6px 12px',
            }}
            aria-label={`复制${copyLabel}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void onCopy(copyLabel, value);
            }}
          >
            复制当前保存内容
          </button>
        </div>
        {normalized.note ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {normalized.note}
          </div>
        ) : null}
        <pre style={debugCodeBlockStyle}>{normalized.displayText}</pre>
      </div>
    </DetailDisclosureCard>
  );
}
