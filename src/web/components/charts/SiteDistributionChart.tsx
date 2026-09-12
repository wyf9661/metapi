import { useEffect, useMemo, useRef, useState } from 'react';
import { VChart } from '@visactor/react-vchart';
import { useThemeLabelColor } from '../useThemeLabelColor.js';
import { useIsMobile } from '../useIsMobile.js';
import {
  barHeadroom,
  CHART_CATEGORY_PALETTE,
  formatAxisMoney,
  formatMoney,
  SITE_CHART_HEADER_MIN_HEIGHT,
} from './chartShared.js';
import { SegmentedToggle } from './SegmentedToggle.js';
import { useI18nOptional } from '../../i18n.js';

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
  /** True while the host panel shows this chart (used to dismiss a locked tooltip on hide). */
  active?: boolean;
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

function EmptyState({ mode }: { mode: ViewMode }) {
  const isSpend = mode === 'spend';
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
        {isSpend ? '今日暂无消耗' : '暂无站点数据'}
      </div>
      <div className="empty-state-desc">
        {isSpend ? '站点今日产生消耗后会自动展示排行' : '添加站点后将自动展示分布图表'}
      </div>
    </div>
  );
}

const VIEW_MODE_STORAGE_KEY = 'metapi:site-chart-view-mode';

export default function SiteDistributionChart({ data, loading, active = true }: SiteDistributionChartProps) {
  // Non-throwing language accessor: keeps the chart renderable in bare tests.
  const language = useI18nOptional()?.language ?? 'zh';
  // Remember the chosen sub-tab across remounts (站点/模型 tab switches) so the
  // layout doesn't silently snap back to the default view.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const stored = window.sessionStorage.getItem(VIEW_MODE_STORAGE_KEY);
      return stored === 'spend' || stored === 'balance' ? stored : 'balance';
    } catch {
      return 'balance';
    }
  });
  const chartRef = useRef<any>(null);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
    } catch {
      // Session storage unavailable — the in-memory state still works.
    }
  }, [viewMode]);
  const labelColor = useThemeLabelColor();
  const isMobile = useIsMobile();

  // 横向柱状图：每站点一行，按值降序。图区固定 344px 与趋势图对齐，
  // 柱子粗细由 barMaxWidth 限制，站点少时留白而非撑粗。
  const { rows: chartData, rankedCount } = useMemo(() => {
    const ranked = (data ?? [])
      .map((item: any) => ({
        siteName: String(item.siteName || '-'),
        platform: String(item.platform || ''),
        value: safeNumber(viewMode === 'balance' ? item.totalBalance : item.todaySpend ?? item.totalSpend),
        accountCount: safeNumber(item.accountCount),
      }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
    return { rows: ranked.slice(0, 10), rankedCount: ranked.length };
  }, [data, viewMode]);

  const hasData = chartData.length > 0 && chartData.some((d) => d.value > 0);

  const BAR_COLORS = CHART_CATEGORY_PALETTE;

  const spec = useMemo(() => {
    if (!hasData) return null;

    const total = chartData.reduce((s, d) => s + d.value, 0);

    // Reserve more horizontal headroom on narrow screens so right-positioned
    // value labels ($xxx.xx) are not clipped by the plot edge.
    const axisHeadroom = barHeadroom(isMobile);
    const maxValue = chartData.reduce((s, d) => Math.max(s, d.value), 0);
    const yAxisMaxWidth = isMobile ? 76 : 140;

    // Rows shown by the bar tooltip. Both the mark and the dimension tooltip
    // carry them: depending on how the click resolves, VChart shows one or the
    // other, and the dimension mode used to fall back to raw unformatted data.
    const tooltipItems = [
      {
        key: (datum: unknown) => {
          const item = coerceDatumRecord(datum);
          return String(item.siteName || '-');
        },
        value: (datum: unknown) => {
          const item = coerceDatumRecord(datum);
          return formatMoney(safeNumber(item.value));
        },
      },
      {
        key: '占比',
        value: (datum: unknown) => {
          const item = coerceDatumRecord(datum);
          return `${safeNumber(item.pct).toFixed(1)}%`;
        },
      },
      {
        key: '账户数',
        value: (datum: unknown) => {
          const item = coerceDatumRecord(datum);
          return String(item.accountCount || 0);
        },
      },
    ] as any;

    // Pin the tooltip near the chart's top-left on phones so it no longer
    // covers the rows around the finger; desktop keeps the hover-follow.
    const tooltipAnchor = isMobile ? ({ left: 8, top: 8 } as any) : undefined;

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
        formatMethod: (text: string | number) => formatMoney(Number(text)),
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
          label: {
            visible: true,
            // Compact dollar ticks ($3k / $12k); sub-$10 ranges keep cents so
            // a small today-spend axis doesn't collapse into "$0 $0 $1 $1".
            formatMethod: (value: unknown) => formatAxisMoney(safeNumber(value)),
            style: { fill: labelColor, fontSize: 11 },
          },
          grid: { visible: false },
          domainLine: { visible: false },
          tick: { visible: false },
          max: Math.ceil(maxValue * axisHeadroom),
        },
      ],
      tooltip: {
        mark: { content: tooltipItems, position: tooltipAnchor },
        dimension: { content: tooltipItems, position: tooltipAnchor },
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

  // The tooltip DOM is portaled to <body>, so hiding the layer alone leaves a
  // locked tooltip floating over the other tab — dismiss it on deactivate.
  useEffect(() => {
    if (!active) chartRef.current?.hideTooltip?.();
  }, [active]);

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
          flexWrap: 'wrap',
          alignContent: 'space-between',
          rowGap: 8,
          columnGap: 12,
          marginBottom: 16,
          minHeight: isMobile ? SITE_CHART_HEADER_MIN_HEIGHT : undefined,
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
            whiteSpace: 'nowrap',
            ...(isMobile ? { flexBasis: '100%' } : {}),
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

        <SegmentedToggle
          style={{ marginLeft: 'auto' }}
          options={[
            {
              key: 'balance' as ViewMode,
              label: '余额分布',
              icon: (
                <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ),
            },
            {
              key: 'spend' as ViewMode,
              label: '今日消耗',
              icon: (
                <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
                </svg>
              ),
            },
          ]}
          value={viewMode}
          onChange={setViewMode}
        />
      </div>

      {/* Content */}
      {loading ? (
        <SkeletonBars />
      ) : !hasData ? (
        <EmptyState mode={viewMode} />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              width: '100%',
              flexShrink: 1,
              flex: 1,
              minHeight: 0,
            }}
          >
            <div style={{ width: '100%', height: '100%' }}>
              {spec && <VChart ref={chartRef} spec={spec} style={{ width: '100%', height: '100%' }} />}
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 10, padding: '0 4px', flexShrink: 0, maxHeight: 68, minHeight: isMobile ? 68 : undefined, overflowY: 'auto' }}>
            {chartData.map((d, idx) => (
              <span key={d.siteName} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: BAR_COLORS[idx % BAR_COLORS.length], flexShrink: 0 }} />
                <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.siteName}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  {formatMoney(d.value)}
                </span>
              </span>
            ))}
          </div>
          <div style={{ marginTop: 6, padding: '0 4px', fontSize: 11, color: 'var(--color-text-muted)', flexShrink: 0, minHeight: isMobile ? 16 : undefined }}>
            {rankedCount > chartData.length
              ? (language === 'en'
                ? `Top ${chartData.length} of ${rankedCount} sites shown`
                : `仅显示前 ${chartData.length} 个站点（共 ${rankedCount} 个）`)
              : null}
          </div>
        </div>
      )}
    </div>
  );
}
