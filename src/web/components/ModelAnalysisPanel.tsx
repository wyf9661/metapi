import { useMemo, useState } from 'react';
import { VChart } from '@visactor/react-vchart';
import { InlineBrandIcon } from './BrandIcon.js';
import { formatCompactTokenMetric } from '../numberFormat.js';
import { useThemeLabelColor } from './useThemeLabelColor.js';
import { useIsMobile } from './useIsMobile.js';
import { availabilityRgb, buildHorizontalBarSpec } from './charts/chartShared.js';

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
  { key: 'spend', label: '花费分布', icon: '💰' },
  { key: 'trend', label: '用量分布', icon: '📊' },
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
  if (n >= 1) return `$${n.toFixed(2)}`;
  // <1: keep 4 decimals max so small balances fit their card on mobile.
  return `$${n.toFixed(4)}`;
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
  const isMobile = useIsMobile();

  const totals = {
    spend: toSafeNumber(data?.totals?.spend),
    calls: toSafeNumber(data?.totals?.calls),
    tokens: toSafeNumber(data?.totals?.tokens),
  };

  const spendDistribution = (data?.spendDistribution || [])
    .filter((d) => toSafeNumber(d.spend) > 0)
    .sort((a, b) => toSafeNumber(b.spend) - toSafeNumber(a.spend))
    .slice(0, 10);
  const spendTrend = data?.spendTrend || [];
  const callsDistribution = (data?.callsDistribution || []).filter((d) => toSafeNumber(d.calls) > 0).slice(0, 10);
  const callRanking = (data?.callRanking || []).filter((d) => toSafeNumber(d.calls) > 0).slice(0, 10);

  const hasData = totals.calls > 0
    || spendDistribution.length > 0
    || spendTrend.some((item) => toSafeNumber(item.spend) > 0);

  const spendBarSpec = useMemo(() => buildHorizontalBarSpec({
    values: spendDistribution.map(d => ({ model: String(d.model || '-'), value: toSafeNumber(d.spend) })).reverse(),
    gradientFrom: '#0f766e', gradientTo: '#0d9488',
    formatLabel: (v) => formatCurrency(v),
    labelColor, isMobile,
  }), [spendDistribution, labelColor, isMobile]);

  const tokenDistribution = useMemo(() => {
    // With 1-day window, trend is meaningless — show per-model tokens instead
    return (data?.callRanking || data?.spendDistribution || [])
      .map((d) => ({
        model: String(d.model || '-'),
        tokens: 'tokens' in d ? toSafeNumber((d as CallRankingItem).tokens) : 0,
      }))
      .filter((d) => d.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10);
  }, [data?.callRanking, data?.spendDistribution]);

  const trendSpec = useMemo(() => buildHorizontalBarSpec({
    values: tokenDistribution.map((d) => ({
      model: String(d.model || '-'),
      value: d.tokens,
    })).reverse(),
    gradientFrom: '#0e7490', gradientTo: '#0891b2',
    formatLabel: (v) => formatCompactTokenMetric(v),
    labelColor, isMobile,
  }), [tokenDistribution, labelColor, isMobile]);

  const callsBarSpec = useMemo(() => buildHorizontalBarSpec({
    values: callsDistribution.map(d => ({ model: String(d.model || '-'), value: toSafeNumber(d.calls) })).reverse(),
    gradientFrom: '#047857', gradientTo: '#059669',
    formatLabel: (v) => v.toLocaleString(),
    labelColor, isMobile,
  }), [callsDistribution, labelColor, isMobile]);

  if (!hasData) return <EmptyBlock />;

  return (
    <div>
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
            <VChart spec={callsBarSpec} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: 10, padding: '0 4px' }}>
            {callsDistribution.map((d) => (
              <span key={d.model} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-success)', flexShrink: 0 }} />
                <InlineBrandIcon model={d.model} size={13} />
                <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.model}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--color-text-primary)' }}>{Math.round(d.calls).toLocaleString()}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'rank' && (
        <div style={{ overflowX: 'auto', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-md)' }}>
          <table className="data-table" style={{ width: '100%', minWidth: 560 }}>
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
                // Latency chip shares the availability palette (red→amber→teal).
                // Map latency to a 0..100 "goodness" score, lower latency = higher
                // score = greener: <=1s ~ excellent, >=30s ~ worst.
                const latGoodness = latSec <= 1
                  ? 100
                  : latSec >= 30
                    ? 0
                    : Math.max(0, 100 - ((latSec - 1) / 29) * 100);
                const lat = availabilityRgb(latGoodness);
                const latColor = `rgb(${lat.r},${lat.g},${lat.b})`;
                const latBg = `rgba(${lat.r},${lat.g},${lat.b},0.1)`;
                const latText = latMs >= 1000 ? `${(latMs / 1000).toFixed(latSec >= 60 ? 0 : 1)}s` : `${latMs}ms`;
                // Success rate chip: same palette, rate itself is the 0..100 score.
                const rate = availabilityRgb(item.successRate);
                const rateColor = `rgb(${rate.r},${rate.g},${rate.b})`;
                const rateBg = `rgba(${rate.r},${rate.g},${rate.b},0.1)`;

                return (
                  <tr key={item.model}>
                    <td style={{ textAlign: 'center', padding: '8px 4px' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22, borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 700,
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
                        padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                        background: rateBg, color: rateColor,
                      }}>
                        {formatPercent(item.successRate)}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{
                        fontVariantNumeric: 'tabular-nums', fontSize: 12, fontWeight: 600,
                        color: latColor, background: latBg,
                        padding: '2px 8px', borderRadius: 6,
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
