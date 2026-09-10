import React, { useState } from 'react';
import type { ProxyLogRenderItem } from './proxyLogsHelpers.js';
import {
  formatProxyLogUseTime,
  getProxyLogFirstTokenVariant,
  getProxyLogResponseTimeVariant,
  proxyLogTimingBarColor,
  proxyLogTimingTextColor,
  resolveProxyLogClientDisplay,
} from './proxyLogsHelpers.js';
import { tr } from '../../i18n.js';

/**
 * Usage-log timing cell: first token + duration in one column, ported from
 * NewAPI's TimingMetricsCell
 * (web/src/features/usage-logs/components/timing-metrics-cell.tsx).
 * A thin status bar sits left of the labels; streaming rows split it into the
 * first-token and duration colors, non-streaming rows show the duration only.
 * Colors live in the bar and the numeric text — no background chips.
 */
export function ProxyLogTimingCell({
  firstByteLatencyMs,
  latencyMs,
  completionTokens,
  isStream,
}: {
  firstByteLatencyMs?: number | null;
  latencyMs?: number | null;
  completionTokens?: number | null;
  isStream?: boolean | null;
}) {
  const showFirstToken = isStream === true;
  const latencySeconds = typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0
    ? latencyMs / 1000
    : null;
  const firstTokenSeconds = typeof firstByteLatencyMs === 'number'
    && Number.isFinite(firstByteLatencyMs)
    && firstByteLatencyMs > 0
    ? firstByteLatencyMs / 1000
    : null;
  const firstTokenVariant = firstTokenSeconds == null
    ? null
    : getProxyLogFirstTokenVariant(firstTokenSeconds);
  const totalVariant = latencySeconds == null
    ? null
    : getProxyLogResponseTimeVariant(latencySeconds, completionTokens ?? 0);

  return (
    <div data-testid="proxy-log-timing" style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
      <span
        aria-hidden="true"
        style={{
          display: 'flex',
          width: 4,
          flexShrink: 0,
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 9999,
          background: showFirstToken
            ? undefined
            : (totalVariant ? proxyLogTimingBarColor(totalVariant) : 'var(--color-text-muted)'),
        }}
      >
        {showFirstToken ? (
          <>
            <span
              style={{
                flex: 1,
                background: firstTokenVariant
                  ? proxyLogTimingBarColor(firstTokenVariant)
                  : 'var(--color-text-muted)',
              }}
            />
            <span
              style={{
                flex: 1,
                background: totalVariant
                  ? proxyLogTimingBarColor(totalVariant)
                  : 'var(--color-text-muted)',
              }}
            />
          </>
        ) : null}
      </span>
      <div
        style={{
          display: 'flex',
          minWidth: 0,
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 4,
          fontSize: 12,
          lineHeight: 1.25,
        }}
      >
        {showFirstToken ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
              {tr('首字')}
            </span>
            <span
              style={{
                fontVariantNumeric: 'tabular-nums',
                color: firstTokenVariant
                  ? proxyLogTimingTextColor(firstTokenVariant)
                  : 'var(--color-text-muted)',
              }}
            >
              {firstTokenSeconds == null ? 'N/A' : formatProxyLogUseTime(firstTokenSeconds)}
            </span>
          </div>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
            {tr('耗时')}
          </span>
          <span
            style={{
              fontVariantNumeric: 'tabular-nums',
              color: totalVariant
                ? proxyLogTimingTextColor(totalVariant)
                : 'var(--color-text-muted)',
            }}
          >
            {latencySeconds == null ? '-' : formatProxyLogUseTime(latencySeconds)}
          </span>
        </div>
      </div>
    </div>
  );
}

export const formInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 13,
  outline: 'none',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
};

export const formSectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 14,
  border: '1px solid var(--color-border-light)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-bg-card)',
};

export const formSectionLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  letterSpacing: '0.02em',
};

export const debugCheckboxRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: 'var(--color-text-primary)',
};

export const compactSummaryMetricStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  minWidth: 112,
};

export const debugCodeBlockStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: 12,
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border-light)',
  background: 'var(--color-bg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  lineHeight: 1.5,
  overflowX: 'auto',
};

export const detailInfoGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
};

export const detailInfoItemStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  minWidth: 0,
};

export const detailInfoLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-muted)',
};

export const detailInfoValueStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-primary)',
  fontWeight: 600,
  minWidth: 0,
  wordBreak: 'break-word',
};

export const detailSectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};

export const detailExpandableCardStyle: React.CSSProperties = {
  border: '1px solid var(--color-border-light)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg-card)',
  overflow: 'hidden',
};

export const detailExpandableSummaryStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  width: '100%',
  padding: '10px 12px',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  borderBottom: '1px solid var(--color-border-light)',
  background:
    'color-mix(in srgb, var(--color-bg-card) 86%, var(--color-bg) 14%)',
};

type DetailDisclosureCardProps = {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
};

export function DetailDisclosureCard({
  title,
  defaultOpen = false,
  children,
}: DetailDisclosureCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={detailExpandableCardStyle}>
      <button
        type="button"
        aria-label={`${open ? '收起' : '展开'}${title}`}
        style={{
          ...detailExpandableSummaryStyle,
          border: 'none',
          cursor: 'pointer',
        }}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{title}</span>
        <span
          style={{
            fontSize: 12,
            color: 'var(--color-text-muted)',
            flexShrink: 0,
          }}
        >
          {open ? '收起' : '展开'}
        </span>
      </button>
      {open ? children : null}
    </div>
  );
}


export function renderProxyLogClientCell(
  log: Pick<
    ProxyLogRenderItem,
    'clientFamily' | 'clientAppName' | 'clientConfidence'
  >,
  options?: { includeGeneric?: boolean },
) {
  const display = resolveProxyLogClientDisplay(log, options);
  if (!display.primary) {
    return <span style={{ color: 'var(--color-text-muted)' }}>-</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          minWidth: 0,
        }}
      >
        <span
          title={display.fullName || undefined}
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {display.primary}
        </span>
        {display.heuristic ? (
          // Plain text, not a chip: a padded box sits on a different baseline
          // than the value next to it and breaks the row alignment.
          <span
            style={{
              flexShrink: 0,
              fontSize: 10,
              color: 'var(--color-text-muted)',
            }}
          >
            推测
          </span>
        ) : null}
      </div>
      {display.secondary ? (
        <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {display.secondary}
        </span>
      ) : null}
    </div>
  );
}

/** Compact stream/non-stream indicator for log tables. */
export function StreamModeIcon({
  isStream,
}: {
  isStream: boolean | null | undefined;
}) {
  if (isStream == null) {
    return (
      <span
        data-testid="proxy-log-stream-unknown"
        style={{ color: 'var(--color-text-muted)', fontSize: 12 }}
      >
        -
      </span>
    );
  }

  if (isStream) {
    return (
      <span
        data-testid="proxy-log-stream-icon"
        title="流式"
        aria-label="流式"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Same muted tone as the non-stream glyph: the shape already tells the
          // two apart, the colour was redundant emphasis.
          color: 'var(--color-text-muted)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 12c2.5-3 5.5-3 8 0s5.5 3 8 0"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M6.5 16.5c1.8-2.2 4-2.2 5.5 0s3.7 2.2 5.5 0"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M7.5 7.5c1.6-2 3.6-2 5 0s3.4 2 5 0"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }

  // Three horizontal lines — pairs with the wave glyph as "complete / non-stream".
  return (
    <span
      data-testid="proxy-log-nonstream-icon"
      title="非流"
      aria-label="非流"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-text-muted)',
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 8h14"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M5 12h14"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M5 16h14"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export function CompactSummaryMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div style={compactSummaryMetricStyle}>
      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        {label}
      </span>
      <strong
        style={{
          fontSize: 14,
          color: 'var(--color-text-primary)',
          fontWeight: 700,
        }}
      >
        {value}
      </strong>
    </div>
  );
}

export { copyText as copyTextToClipboard } from '../../clipboard.js';
