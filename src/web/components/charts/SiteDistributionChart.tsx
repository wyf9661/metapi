import { useState, useMemo } from 'react';
import { VChart } from '@visactor/react-vchart';
import { useThemeLabelColor } from '../useThemeLabelColor.js';
import { useIsMobile } from '../useIsMobile.js';
import { barHeadroom } from './chartShared.js';

interface SiteDistributionData {
  siteName: string;
  platform: string;
  totalBalance: number;
  totalSpend: number;
  todaySpend?: number;
  accountCount: number;
}

interface SiteDistributionChartProps {
  data: SiteDistributionData[];
  loading?: boolean;
}

type ViewMode = 'balance' | 'spend';

function coerceDatumRecord(datum: unknown): Record<string, unknown> {
  return datum && typeof datum === 'object' ? datum as Record<string, unknown> : {};
}

function safeNumber(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return value;
}

function SkeletonBars() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 14,
        padding: '24px 8px',
        maxWidth: 320,
        margin: '0 auto',
      }}
    >
      {[...Array(6)].map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="skeleton" style={{ width: 80, height: 12, borderRadius: 6, flexShrink: 0 }} />
          <div className="skeleton" style={{ width: 140 + i * 18, height: 16, borderRadius: 6 }} />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state" style={{ padding: 40 }}>
      <div style={{ margin: '0 auto 16px', width: 64, height: 64, opacity: 0.35 }}>
        <svg
          width="64"
          height="64"
          fill="none"
          viewBox="0 0 24 24"
          stroke="var(--color-text-muted)"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1}
            d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1}
            d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"
          />
        </svg>
      </div>
      <div className="empty-state-title" style={{ marginBottom: 4 }}>
        暂无站点数据
      </div>
      <div className="empty-state-desc">添加站点后将自动展示分布图表</div>
    </div>
  );
}

export default function SiteDistributionChart({ data, loading }: SiteDistributionChartProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('balance');
  const labelColor = useThemeLabelColor();
  const isMobile = useIsMobile();

  // 横向柱状图：每站点一行，按值降序。图区固定 344px 与趋势图对齐，
  // 柱子粗细由 barMaxWidth 限制，站点少时留白而非撑粗。
  const chartData = useMemo(() => {
    const rows = (data ?? [])
      .map((item: any) => ({
        siteName: String(item.siteName || '-'),
        platform: String(item.platform || ''),
        value: safeNumber(viewMode === 'balance' ? item.totalBalance : item.todaySpend ?? item.totalSpend),
        accountCount: safeNumber(item.accountCount),
      }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, Math.min(10, Array.isArray(data) ? data.length : 10));
    return rows;
  }, [data, viewMode]);

  const hasData = chartData.length > 0 && chartData.some((d) => d.value > 0);

  const BAR_COLORS = [
    '#0d9488', '#06b6d4', '#10b981', '#f59e0b',
    '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6',
    '#f97316', '#3b82f6', '#a855f7', '#22c55e',
    '#eab308', '#6366f1', '#d946ef', '#84cc16',
  ];

  const formatValue = (value: number): string => `$${value.toFixed(2)}`;

  const spec = useMemo(() => {
    if (!hasData) return null;

    const total = chartData.reduce((s, d) => s + d.value, 0);

    // Reserve more horizontal headroom on narrow screens so right-positioned
    // value labels ($xxx.xx) are not clipped by the plot edge.
    const axisHeadroom = barHeadroom(isMobile);
    const maxValue = chartData.reduce((s, d) => Math.max(s, d.value), 0);
    const yAxisMaxWidth = isMobile ? 76 : 140;

    return {
      type: 'bar' as const,
      data: [{ id: 'siteData', values: chartData.map((d) => ({ ...d, pct: total > 0 ? (d.value / total * 100) : 0 })) }],
      xField: 'value',
      yField: 'siteName',
      direction: 'horizontal' as const,
      // Cap bar thickness so a short site list doesn't stretch bars to fill
      // the fixed 344px plot height — extra space stays as row gaps.
      barMaxWidth: 22,
      bar: {
        style: {
          cornerRadius: 3,
          fill: (datum: any) => {
            const idx = chartData.findIndex((d) => d.siteName === datum?.siteName);
            return BAR_COLORS[Math.max(0, idx) % BAR_COLORS.length];
          },
        },
      },
      label: {
        visible: true,
        position: 'right',
        formatMethod: (text: string | number) => formatValue(Number(text)),
        style: { fill: labelColor, fontSize: 11, stroke: 'transparent' },
      },
      axes: [
        {
          orient: 'left',
          label: {
            visible: true,
            style: { fill: labelColor, fontSize: 11 },
            maxWidth: yAxisMaxWidth,
            overflow: 'truncate',
          },
          domainLine: { visible: false },
          tick: { visible: false },
        },
        {
          orient: 'bottom',
          label: { visible: true, format: (value: unknown) => formatValue(safeNumber(value)), style: { fill: labelColor, fontSize: 11 } },
          grid: { visible: false },
          domainLine: { visible: false },
          tick: { visible: false },
          max: Math.ceil(maxValue * axisHeadroom),
        },
      ],
      tooltip: {
        mark: {
          content: [
            {
              key: (datum: unknown) => {
                const item = coerceDatumRecord(datum);
                return String(item.siteName || '-');
              },
              value: (datum: unknown) => {
                const item = coerceDatumRecord(datum);
                const val = safeNumber(item.value);
                return `${formatValue(val)}`;
              },
            },
            {
              key: '占比',
              value: (datum: unknown) => {
                const item = coerceDatumRecord(datum);
                const pct = safeNumber(item.pct);
                return `${pct.toFixed(1)}%`;
              },
            },
            {
              key: '账户数',
              value: (datum: unknown) => {
                const item = coerceDatumRecord(datum);
                return String(item.accountCount || 0);
              },
            },
          ] as any,
        },
        className: 'chart-tooltip',
        trigger: (isMobile ? 'click' : 'hover') as 'click' | 'hover',
        // Desktop must hide on hover-out; 'none' left the tooltip stuck on
        // screen after the pointer left the bar. Mobile keeps click-to-toggle.
        triggerOff: (isMobile ? 'click' : 'hover') as 'click' | 'hover',
        lockAfterClick: isMobile,
      },
      legends: { visible: false },
      animation: true,
      background: 'transparent',
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
    };
  }, [chartData, hasData, labelColor, isMobile]);

  return (
    <div
      className="chart-container animate-fade-in"
      style={{ padding: 0, height: '100%', display: 'flex', flexDirection: 'column', border: 'none', boxShadow: 'none', background: 'transparent' }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
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
              d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"
            />
          </svg>
          站点 TOP 排行榜
        </div>

        {/* Toggle buttons */}
        <div
          style={{
            display: 'flex',
            gap: 0,
            background: 'var(--color-bg)',
            borderRadius: 'var(--radius-sm)',
            padding: 3,
            border: '1px solid var(--color-border-light)',
          }}
        >
          <button
            onClick={() => setViewMode('balance')}
            style={{
              padding: '5px 14px',
              fontSize: 12,
              fontWeight: 500,
              border: 'none',
              borderRadius: 'calc(var(--radius-sm) - 2px)',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              background: viewMode === 'balance' ? 'var(--color-primary)' : 'transparent',
              color: viewMode === 'balance' ? '#ffffff' : 'var(--color-text-secondary)',
              boxShadow: viewMode === 'balance' ? 'var(--shadow-sm)' : 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            余额分布
          </button>
          <button
            onClick={() => setViewMode('spend')}
            style={{
              padding: '5px 14px',
              fontSize: 12,
              fontWeight: 500,
              border: 'none',
              borderRadius: 'calc(var(--radius-sm) - 2px)',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              background: viewMode === 'spend' ? 'var(--color-primary)' : 'transparent',
              color: viewMode === 'spend' ? '#ffffff' : 'var(--color-text-secondary)',
              boxShadow: viewMode === 'spend' ? 'var(--shadow-sm)' : 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
            </svg>
            今日消耗
          </button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <SkeletonBars />
      ) : !hasData ? (
        <EmptyState />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              width: '100%',
              flexShrink: 1,
              // Keep the plot region at least as tall as the trend chart's
              // fixed 344px so the card doesn't resize when toggling between
              // "站点分布" and "站点趋势". The inner bar chart still sizes to
              // its rows; short lists just leave breathing room below.
              minHeight: 344,
            }}
          >
            <div style={{ width: '100%', height: 344 }}>
              {spec && <VChart spec={spec} style={{ width: '100%', height: '100%' }} />}
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 10, padding: '0 4px', flexShrink: 0, maxHeight: 68, overflowY: 'auto' }}>
            {chartData.map((d, idx) => (
              <span key={d.siteName} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: BAR_COLORS[idx % BAR_COLORS.length], flexShrink: 0 }} />
                <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.siteName}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  {formatValue(d.value)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
