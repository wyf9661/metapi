import React, { useEffect, useMemo, useState } from 'react';
import { VChart } from '@visactor/react-vchart';
import { api } from '../../api.js';
import { useThemeLabelColor } from '../useThemeLabelColor.js';
import { useIsMobile } from '../useIsMobile.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SiteTrendData {
  date: string;
  sites: Record<string, { spend: number; calls: number }>;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

type Metric = 'spend' | 'calls';

const METRIC_OPTIONS: { key: Metric; label: string }[] = [
  { key: 'spend', label: '消耗趋势' },
  { key: 'calls', label: '调用趋势' },
];

/** Short x-axis label: "08-22" for daily buckets, "13:00" for hourly ones. */
function formatTrendBucketLabel(date: string): string {
  if (!date) return '';
  const match = /^\d{4}-\d{2}-\d{2} (\d{2}):00/.exec(date);
  if (match) return match[1]!;
  const day = /^\d{4}-(\d{2}-\d{2})/.exec(date);
  return day ? day[1]! : date;
}

const COLOR_PALETTE = [
  '#0d9488', '#06b6d4', '#10b981', '#f59e0b',
  '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6',
  '#f97316', '#3b82f6', '#a855f7', '#22c55e',
  '#eab308', '#6366f1', '#d946ef', '#84cc16',
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function SiteTrendChart() {
  const [metric, setMetric] = useState<Metric>('spend');
  const labelColor = useThemeLabelColor();
  const isMobile = useIsMobile();
  const [focusedSite, setFocusedSite] = useState<string | null>(null);
  const [trendDays, setTrendDays] = useState(7);
  const [data, setData] = useState<SiteTrendData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getSiteTrend(trendDays)
      .then((res) => {
        if (cancelled) return;
        const trend = Array.isArray((res as { trend?: unknown })?.trend) ? (res as { trend: SiteTrendData[] }).trend : [];
        setData(trend);
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to load site trend:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trendDays]);

  const allSites = useMemo(() => {
    if (!data || data.length === 0) return [] as string[];
    const names = new Set<string>();
    for (const day of data) {
      for (const site of Object.keys(day.sites || {})) names.add(site);
    }
    return Array.from(names);
  }, [data]);

  /* ---------- data transform ---------- */

  const flatData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return data.flatMap((d) =>
      Object.entries(d.sites)
        .filter(([site]) => !focusedSite || site === focusedSite)
        .map(([site, v]) => ({
          date: d.date,
          site,
          value: metric === 'spend' ? v.spend : v.calls,
        })),
    );
  }, [data, metric, focusedSite]);

  const toggleFocusedSite = (site: string) => {
    setFocusedSite((current) => (current === site ? null : site));
  };

  /* ---------- loading state ---------- */

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <div className="skeleton" style={{ width: 200, height: 32, borderRadius: 'var(--radius-sm)' }} />
        </div>
        <div className="skeleton" style={{ width: '100%', height: 300, borderRadius: 'var(--radius-sm)' }} />
      </div>
    );
  }

  /* ---------- empty state ---------- */

  if (!data || data.length === 0 || flatData.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <MetricToggle metric={metric} onChange={setMetric} />
        </div>
        <div className="empty-state" style={{ padding: 48 }}>
          <div className="empty-state-title">暂无趋势数据</div>
          <div className="empty-state-desc">数据加载后将自动展示趋势图表</div>
        </div>
      </div>
    );
  }

  /* ---------- vchart spec ---------- */

  const spec: Record<string, unknown> = {
    type: 'line' as const,
    data: [{ id: 'data', values: flatData }],
    xField: 'date',
    yField: 'value',
    seriesField: 'site',
    point: {
      visible: true,
      style: { size: 6 },
    },
    line: {
      style: { lineWidth: 2, curveType: 'monotone' },
    },
    // Built-in legend removed: bottom chips are the only site list / selector.
    legends: {
      visible: false,
    },
    tooltip: {
      mark: {
        title: { value: (datum: Record<string, unknown>) => formatTrendBucketLabel(String(datum?.date ?? '')) },
        content: [
          {
            key: (datum: Record<string, unknown>) => datum?.site ?? '',
            value: (datum: Record<string, unknown>) => {
              const v = Number(datum?.value ?? 0);
              return metric === 'spend' ? `$${v.toFixed(4)}` : String(v);
            },
          },
        ],
      },
      dimension: {
        title: { value: (datum: Record<string, unknown>) => formatTrendBucketLabel(String(datum?.date ?? '')) },
        content: [
          {
            key: (datum: Record<string, unknown>) => datum?.site ?? '',
            value: (datum: Record<string, unknown>) => {
              const v = Number(datum?.value ?? 0);
              return metric === 'spend' ? `$${v.toFixed(4)}` : String(v);
            },
          },
        ],
      },
      className: 'chart-tooltip',
      trigger: (isMobile ? 'click' : 'hover') as 'click' | 'hover',
      triggerOff: (isMobile ? 'click' : 'none') as 'click' | 'none',
      lockAfterClick: isMobile,
    },
    animation: true,
    animationAppear: {
      line: { type: 'clipIn', duration: 800, easing: 'cubicOut' },
      point: { type: 'fadeIn', duration: 600, delay: 400, easing: 'cubicOut' },
    },
    axes: [
      {
        orient: 'bottom',
        label: {
          style: { fontSize: 11, fill: labelColor },
          formatMethod: (value: string | number) => formatTrendBucketLabel(String(value)),
        },
        domainLine: { style: { stroke: 'var(--color-border-light)' } },
        tick: { style: { stroke: 'var(--color-border-light)' } },
      },
      {
        orient: 'left',
        label: {
          visible: true,
          formatMethod: (value: string | number) => {
            const v = Number(value);
            return metric === 'spend' ? `$${v.toFixed(2)}` : String(Math.round(v));
          },
          style: { fontSize: 11, fill: labelColor },
        },
        grid: { style: { stroke: 'var(--color-border-light)', lineDash: [4, 4] } },
        domainLine: { visible: false },
      },
    ],
    color: {
      field: 'site',
      domain: allSites,
      range: COLOR_PALETTE,
    },
    background: 'transparent',
    padding: { left: 20, right: 16, top: 8, bottom: 8 },
  };

  /* ---------- render ---------- */

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--color-text-primary)',
          }}
        >
          <svg
            width="16"
            height="16"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 3v18h18"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 14l4-4 3 3 5-6"
            />
          </svg>
          站点趋势
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <MetricToggle metric={metric} onChange={setMetric} />
          <div style={toggleGroupStyle}>
            {[1, 3, 7].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setTrendDays(d)}
                style={{
                  ...toggleBtnBase,
                  ...(trendDays === d ? toggleBtnActive : toggleBtnInactive),
                }}
              >
                {d}天
              </button>
            ))}
          </div>
          {focusedSite && (
            <div style={focusChipStyle}>
              <span>当前查看：</span>
              <strong style={{ color: 'var(--color-text-primary)' }}>{focusedSite}</strong>
              <button
                type="button"
                onClick={() => setFocusedSite(null)}
                style={focusClearBtnStyle}
              >
                显示全部
              </button>
            </div>
          )}
        </div>
      </div>
      <div style={{ width: '100%', height: 344, flex: 1, minHeight: 344 }}>
        <VChart
          spec={spec as any}
          style={{ width: '100%', height: '100%' }}
          onClick={(params: any) => {
            const site = params?.datum?.site ?? params?.event?.target?.datum?.site;
            if (typeof site === 'string' && site) {
              toggleFocusedSite(site);
            }
          }}
        />
      </div>
      {/* Site list / selector (replaces chart built-in legend) */}
      {allSites.length > 0 && (
        <div style={legendFallbackStyle}>
          {allSites.map((site, idx) => {
            const active = !focusedSite || focusedSite === site;
            return (
              <button
                key={site}
                type="button"
                onClick={() => toggleFocusedSite(site)}
                style={{
                  ...legendChipStyle,
                  opacity: active ? 1 : 0.4,
                  borderColor: focusedSite === site
                    ? 'color-mix(in srgb, var(--color-primary) 40%, var(--color-border))'
                    : 'transparent',
                  background: focusedSite === site
                    ? 'color-mix(in srgb, var(--color-primary) 10%, transparent)'
                    : 'transparent',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: COLOR_PALETTE[idx % COLOR_PALETTE.length],
                    flexShrink: 0,
                  }}
                />
                <span>{site}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function MetricToggle({
  metric,
  onChange,
}: {
  metric: Metric;
  onChange: (m: Metric) => void;
}) {
  return (
    <div style={toggleGroupStyle}>
      {METRIC_OPTIONS.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          style={{
            ...toggleBtnBase,
            ...(metric === opt.key ? toggleBtnActive : toggleBtnInactive),
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {opt.key === 'spend' ? (
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
            </svg>
          ) : (
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles (inline, consistent with project conventions)               */
/* ------------------------------------------------------------------ */

const containerStyle: React.CSSProperties = {
  background: 'transparent',
  padding: 0,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 16,
  flexWrap: 'wrap',
};

const toggleGroupStyle: React.CSSProperties = {
  display: 'inline-flex',
  gap: 0,
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border)',
  overflow: 'hidden',
};

const toggleBtnBase: React.CSSProperties = {
  padding: '6px 16px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  border: 'none',
  transition: 'all 0.2s ease',
  fontFamily: 'inherit',
};

const toggleBtnActive: React.CSSProperties = {
  background: 'var(--color-primary)',
  color: '#ffffff',
};

const toggleBtnInactive: React.CSSProperties = {
  background: 'var(--color-bg-card)',
  color: 'var(--color-text-secondary)',
};

const focusChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 10px',
  borderRadius: 999,
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg)',
  fontSize: 12,
  color: 'var(--color-text-secondary)',
};

const focusClearBtnStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-card)',
  color: 'var(--color-text-primary)',
  borderRadius: 999,
  padding: '2px 8px',
  fontSize: 11,
  cursor: 'pointer',
};

const legendFallbackStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px 14px',
  marginTop: 10,
  padding: '0 4px',
  maxHeight: 68,
  overflowY: 'auto',
  flexShrink: 0,
};

const legendChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  borderRadius: 999,
  border: '1px solid transparent',
  padding: '0 10px',
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--color-text-secondary)',
  cursor: 'pointer',
  background: 'transparent',
};
