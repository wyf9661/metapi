import { useState, useMemo } from 'react';
import { VChart } from '@visactor/react-vchart';
import { useThemeLabelColor } from '../useThemeLabelColor.js';

interface SiteDistributionData {
  siteName: string;
  platform: string;
  totalBalance: number;
  totalSpend: number;
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
          <div className="skeleton" style={{ width: 80, height: 12, borderRadius: 3, flexShrink: 0 }} />
          <div className="skeleton" style={{ width: 140 + i * 18, height: 16, borderRadius: 3 }} />
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
            strokeWidth={1.2}
            d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.2}
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

  // 横向柱状图：每站点一行，按值降序，站点多时可滚动
  const MAX_VISIBLE_HEIGHT = 344;
  const ROW_HEIGHT = 30; // 每行条形高度（含间距）
  const AXIS_RESERVE = 44; // x 轴标签预留

  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return data
      .map((item) => ({
        siteName: String(item.siteName || '-'),
        platform: String(item.platform || ''),
        value: safeNumber(viewMode === 'balance' ? item.totalBalance : item.totalSpend),
        accountCount: safeNumber(item.accountCount),
      }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [data, viewMode]);

  const hasData = chartData.length > 0 && chartData.some((d) => d.value > 0);

  const chartHeight = Math.max(200, chartData.length * ROW_HEIGHT + AXIS_RESERVE);
  const needsScroll = chartHeight > MAX_VISIBLE_HEIGHT;

  const BAR_COLORS = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

  const formatValue = (value: number): string => `$${value.toFixed(2)}`;

  const spec = useMemo(() => {
    if (!hasData) return null;

    const total = chartData.reduce((s, d) => s + d.value, 0);

    return {
      type: 'bar' as const,
      data: [{ id: 'siteData', values: chartData.map((d) => ({ ...d, pct: total > 0 ? (d.value / total * 100) : 0 })) }],
      xField: 'value',
      yField: 'siteName',
      seriesField: 'siteName',
      direction: 'horizontal' as const,
      bar: { style: { cornerRadius: 3 } },
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
            maxWidth: 140,
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
        },
      ],
      legends: { visible: false },
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
      },
      color: BAR_COLORS,
      animation: true,
      background: 'transparent',
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
    };
  }, [chartData, hasData, labelColor]);

  return (
    <div
      className="chart-container animate-fade-in"
      style={{ padding: 20, height: '100%', display: 'flex', flexDirection: 'column' }}
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
          站点分布
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
            }}
          >
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
            }}
          >
            消耗分布
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
              overflowY: needsScroll ? 'auto' : 'hidden',
              maxHeight: needsScroll ? MAX_VISIBLE_HEIGHT : undefined,
              flexShrink: 1,
              minHeight: 0,
            }}
          >
            <div style={{ width: '100%', height: chartHeight }}>
              {spec && <VChart spec={spec} style={{ width: '100%', height: '100%' }} />}
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 10, padding: '0 4px', flexShrink: 0 }}>
            {chartData.map((d, idx) => (
              <span key={d.siteName} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: BAR_COLORS[idx % BAR_COLORS.length], flexShrink: 0 }} />
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
