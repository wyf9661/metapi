import { useMemo, useState } from 'react';
import { VChart } from '@visactor/react-vchart';
import { InlineBrandIcon } from './BrandIcon.js';
import { formatCompactTokenMetric } from '../numberFormat.js';
import { useThemeLabelColor } from './useThemeLabelColor.js';

type TabKey = 'spend' | 'trend' | 'calls' | 'rank';

interface SpendDistributionItem { model: string; spend: number; calls: number; }
interface SpendTrendItem { day: string; spend: number; }
interface CallsDistributionItem { model: string; calls: number; share: number; }
interface CallRankingItem { model: string; calls: number; successRate: number; avgLatencyMs: number; spend: number; tokens: number; }

interface ModelAnalysisData {
  window?: { start?: string; end?: string; days?: number };
  totals?: { spend?: number; calls?: number; tokens?: number };
  spendDistribution?: SpendDistributionItem[];
  spendTrend?: SpendTrendItem[];
  callsDistribution?: CallsDistributionItem[];
  callRanking?: CallRankingItem[];
}

interface ModelAnalysisPanelProps {
  data?: ModelAnalysisData | null;
}

const tabs: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'spend', label: '今日消耗', icon: '💰' },
  { key: 'trend', label: 'Token 分布', icon: '📊' },
  { key: 'calls', label: '调用分布', icon: '🔄' },
  { key: 'rank', label: '模型排行', icon: '🏆' },
];

function toSafeNumber(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return value;
}

function formatCurrency(value: number): string {
  const n = toSafeNumber(value);
  if (n >= 1000) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(6)}`;
}

function formatPercent(value: number): string {
  return `${toSafeNumber(value).toFixed(1)}%`;
}

function EmptyBlock() {
  return (
    <div className="empty-state" style={{ padding: 28 }}>
      <div className="empty-state-title">今日暂无模型调用数据</div>
      <div className="empty-state-desc">今日有代理流量进入后会自动生成统计图表</div>
    </div>
  );
}

export default function ModelAnalysisPanel({ data }: ModelAnalysisPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('spend');
  const labelColor = useThemeLabelColor();

  const totals = {
    spend: toSafeNumber(data?.totals?.spend),
    calls: toSafeNumber(data?.totals?.calls),
    tokens: toSafeNumber(data?.totals?.tokens),
  };

  const spendDistribution = (data?.spendDistribution || []).slice(0, 10);
  const spendTrend = data?.spendTrend || [];
  const callsDistribution = (data?.callsDistribution || []).slice(0, 10);
  const callRanking = (data?.callRanking || []).slice(0, 10);

  const hasData = totals.calls > 0
    || spendDistribution.length > 0
    || spendTrend.some((item) => toSafeNumber(item.spend) > 0);

  const spendBarSpec = useMemo(() => ({
    type: 'bar' as const,
    data: [{ id: 'data', values: spendDistribution.map(d => ({ model: d.model.length > 25 ? d.model.slice(0, 25) + '...' : d.model, value: toSafeNumber(d.spend) })).reverse() }],
    xField: 'value', yField: 'model', direction: 'horizontal' as const,
    bar: { style: { cornerRadius: [0, 6, 6, 0], fill: { gradient: 'linear' as const, x0: 0, y0: 0, x1: 1, y1: 0, stops: [{ offset: 0, color: '#4f46e5' }, { offset: 1, color: '#818cf8' }] } } },
    label: { visible: true, position: 'right', formatter: '{value}', style: { fontSize: 11, fill: labelColor, stroke: 'transparent' } },
    axes: [{ orient: 'left', label: { style: { fontSize: 11, fill: labelColor } } }, { orient: 'bottom', visible: false }],
    animation: true, background: 'transparent',
  }), [spendDistribution, labelColor]);

  const tokenDistribution = useMemo(() => {
    // With 1-day window, trend is meaningless — show per-model tokens instead
    return (data?.callRanking || data?.spendDistribution || []).slice(0, 10).map((d) => ({
      model: d.model,
      tokens: 'tokens' in d ? toSafeNumber((d as CallRankingItem).tokens) : 0,
    }));
  }, [data?.callRanking, data?.spendDistribution]);

  const trendSpec = useMemo(() => {
    const tokenData = tokenDistribution.map((d) => ({
      model: d.model.length > 20 ? d.model.slice(0, 20) + '...' : d.model,
      value: d.tokens,
    })).reverse();
    return {
      type: 'bar' as const,
      data: [{ id: 'data', values: tokenData }],
      xField: 'value', yField: 'model', direction: 'horizontal' as const,
      bar: { style: { cornerRadius: [0, 6, 6, 0], fill: { gradient: 'linear' as const, x0: 0, y0: 0, x1: 1, y1: 0, stops: [{ offset: 0, color: '#06b6d4' }, { offset: 1, color: '#22d3ee' }] } } },
      label: { visible: true, position: 'right', formatter: '{value}', style: { fontSize: 11, fill: labelColor, stroke: 'transparent' } },
      axes: [{ orient: 'left', label: { style: { fontSize: 11, fill: labelColor } } }, { orient: 'bottom', visible: false }],
      animation: true, background: 'transparent',
    };
  }, [tokenDistribution, labelColor]);

  const callsPieSpec = useMemo(() => ({
    type: 'pie' as const,
    data: [{ id: 'data', values: callsDistribution.map(d => ({ model: d.model, calls: toSafeNumber(d.calls) })) }],
    valueField: 'calls', categoryField: 'model',
    outerRadius: 0.8, innerRadius: 0.55,
    pie: { style: { cornerRadius: 4, padAngle: 0.02 } },
    label: { visible: true, position: 'outside', formatter: '{_percent_}%', style: { fill: labelColor } },
    legends: { visible: false },
    animation: true,
    color: ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'],
    background: 'transparent',
  }), [callsDistribution, labelColor]);

  if (!hasData) return <EmptyBlock />;

  return (
    <div>
      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginBottom: 16 }}>
        <div className="stat-summary-card stat-summary-purple" style={{ minHeight: 72, padding: '12px 14px' }}>
          <div className="stat-summary-card-label">今日消耗</div>
          <div className="stat-summary-card-value" style={{ fontSize: 20 }}>{formatCurrency(totals.spend)}</div>
        </div>
        <div className="stat-summary-card stat-summary-blue" style={{ minHeight: 72, padding: '12px 14px' }}>
          <div className="stat-summary-card-label">今日调用</div>
          <div className="stat-summary-card-value" style={{ fontSize: 20 }}>{Math.round(totals.calls).toLocaleString()}</div>
        </div>
        <div className="stat-summary-card stat-summary-green" style={{ minHeight: 72, padding: '12px 14px' }}>
          <div className="stat-summary-card-label">今日 Tokens</div>
          <div className="stat-summary-card-value" style={{ fontSize: 20 }}>{formatCompactTokenMetric(totals.tokens)}</div>
        </div>
      </div>

      {/* Pill Tabs */}
      <div style={{ marginBottom: 16 }}>
        <div className="pill-tabs">
          {tabs.map(tab => (
            <button
              key={tab.key}
              className={`pill-tab ${activeTab === tab.key ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart Content */}
      {activeTab === 'spend' && (
        <div>
          <div style={{ height: 300 }}>
            <VChart spec={spendBarSpec} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 10, padding: '0 4px' }}>
            {spendDistribution.map(d => (
              <span key={d.model} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                <InlineBrandIcon model={d.model} size={13} />
                <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.model}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--color-text-primary)' }}>{formatCurrency(d.spend)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'trend' && (
        <div>
          <div style={{ height: 300 }}>
            <VChart spec={trendSpec} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 10, padding: '0 4px' }}>
            {tokenDistribution.map((d) => (
              <span key={d.model} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                <InlineBrandIcon model={d.model} size={13} />
                <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.model}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--color-text-primary)' }}>{formatCompactTokenMetric(d.tokens)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'calls' && (
        <div>
          <div style={{ height: 300 }}>
            <VChart spec={callsPieSpec} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 10, padding: '0 4px' }}>
            {callsDistribution.map((d, idx) => {
              const pieColors = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
              return (
                <span key={d.model} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: pieColors[idx % pieColors.length], flexShrink: 0 }} />
                  <InlineBrandIcon model={d.model} size={13} />
                  <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.model}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--color-text-primary)' }}>{d.calls}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'rank' && (
        <div style={{ overflow: 'hidden', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-md)' }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: 36, textAlign: 'center' }}>#</th>
                <th>模型</th>
                <th style={{ textAlign: 'center' }}>调用</th>
                <th style={{ textAlign: 'center' }}>成功率</th>
                <th style={{ textAlign: 'center' }}>平均延迟</th>
                <th style={{ textAlign: 'right' }}>消耗</th>
              </tr>
            </thead>
            <tbody>
              {callRanking.map((item, index) => {
                const latMs = item.avgLatencyMs;
                const latSec = latMs / 1000;
                // ≤15s green, 15-60s gradient green→yellow→red, >60s or failed → red
                let latColor: string;
                let latBg: string;
                if (latSec <= 15) {
                  // green gradient: 0s=#22c55e → 15s=blend towards yellow
                  const t = Math.min(latSec / 15, 1);
                  const r = Math.round(34 + t * (245 - 34));
                  const g = Math.round(197 + t * (158 - 197));
                  const b = Math.round(94 + t * (11 - 94));
                  latColor = `rgb(${r},${g},${b})`;
                  latBg = `rgba(${r},${g},${b},0.08)`;
                } else if (latSec <= 60) {
                  // yellow→red gradient: 15s=#f59e0b → 60s=#ef4444
                  const t = Math.min((latSec - 15) / 45, 1);
                  const r = Math.round(245 + t * (239 - 245));
                  const g = Math.round(158 + t * (68 - 158));
                  const b = Math.round(11 + t * (68 - 11));
                  latColor = `rgb(${r},${g},${b})`;
                  latBg = `rgba(${r},${g},${b},0.08)`;
                } else {
                  latColor = '#ef4444';
                  latBg = 'rgba(239,68,68,0.08)';
                }
                const latText = latMs >= 1000 ? `${(latMs / 1000).toFixed(latSec >= 60 ? 0 : 1)}s` : `${latMs}ms`;
                const rateColor = item.successRate >= 90 ? '#16a34a' : item.successRate >= 60 ? '#d97706' : '#dc2626';
                const rateBg = item.successRate >= 90 ? 'rgba(34,197,94,0.1)' : item.successRate >= 60 ? 'rgba(245,158,11,0.1)' : 'rgba(239,68,68,0.1)';

                return (
                  <tr key={item.model}>
                    <td style={{ textAlign: 'center', padding: '8px 4px' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22, borderRadius: 6, fontSize: 11, fontWeight: 700,
                        background: index < 3
                          ? ['linear-gradient(135deg,#fbbf24,#f59e0b)', 'linear-gradient(135deg,#94a3b8,#cbd5e1)', 'linear-gradient(135deg,#d97706,#fbbf24)'][index]
                          : 'var(--color-bg)',
                        color: index < 3 ? '#fff' : 'var(--color-text-muted)',
                      }}>
                        {index + 1}
                      </span>
                    </td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <InlineBrandIcon model={item.model} size={14} />
                        <code style={{ fontSize: 12, fontWeight: 500 }}>{item.model}</code>
                      </span>
                    </td>
                    <td style={{ textAlign: 'center', fontWeight: 600, fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                      {Math.round(item.calls).toLocaleString()}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                        background: rateBg, color: rateColor,
                      }}>
                        {formatPercent(item.successRate)}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{
                        fontVariantNumeric: 'tabular-nums', fontSize: 12, fontWeight: 600,
                        color: latColor, background: latBg,
                        padding: '2px 8px', borderRadius: 4,
                      }}>
                        {latText}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500, fontSize: 13 }}>
                      {formatCurrency(item.spend)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
