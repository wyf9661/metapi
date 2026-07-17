export function percentileNearestRank(
  values: Array<number | null | undefined>,
  percentile: number,
): number | null {
  const sorted = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const normalized = Math.min(1, Math.max(0, percentile));
  const rank = Math.max(1, Math.ceil(normalized * sorted.length));
  return Math.round(sorted[Math.min(sorted.length - 1, rank - 1)]!);
}

export type ProxyQualityMetrics = {
  sampleCount: number;
  successRatePercent: number | null;
  p95FirstByteLatencyMs: number | null;
  p95LatencyMs: number | null;
  sparse: boolean;
};

export function calculateProxyQualityMetrics(rows: Array<{
  status?: string | null;
  firstByteLatencyMs?: number | null;
  latencyMs?: number | null;
}>, sparseThreshold = 20): ProxyQualityMetrics {
  const sampleCount = rows.length;
  const successCount = rows.reduce((count, row) => (
    String(row.status || '').trim().toLowerCase() === 'success' ? count + 1 : count
  ), 0);
  return {
    sampleCount,
    successRatePercent: sampleCount > 0
      ? Math.round((successCount / sampleCount) * 1000) / 10
      : null,
    p95FirstByteLatencyMs: percentileNearestRank(
      rows.map((row) => row.firstByteLatencyMs),
      0.95,
    ),
    p95LatencyMs: percentileNearestRank(
      rows.map((row) => row.latencyMs),
      0.95,
    ),
    sparse: sampleCount < sparseThreshold,
  };
}
