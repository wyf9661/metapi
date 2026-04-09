import {
  formatLocalDate,
  parseStoredUtcDateTime,
  type StoredUtcDateTimeInput,
} from './localTimeService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ProxyLogLike {
  createdAt: StoredUtcDateTimeInput;
  modelActual: string | null;
  modelRequested: string | null;
  status: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
}

interface ModelAnalysisResult {
  window: {
    start: string;
    end: string;
    days: number;
  };
  totals: {
    calls: number;
    tokens: number;
    spend: number;
  };
  spendDistribution: Array<{
    model: string;
    spend: number;
    calls: number;
  }>;
  spendTrend: Array<{
    day: string;
    spend: number;
  }>;
  callsDistribution: Array<{
    model: string;
    calls: number;
    share: number;
  }>;
  callRanking: Array<{
    model: string;
    calls: number;
    successRate: number;
    avgLatencyMs: number;
    spend: number;
    tokens: number;
  }>;
}

interface BuildOptions {
  now?: Date;
  days?: number;
  maxModels?: number;
}

export interface ModelAnalysisDailyUsageRow {
  localDay: string;
  model: string;
  totalCalls: number;
  successCalls: number;
  totalTokens: number;
  totalSpend: number;
  totalLatencyMs: number;
}

interface MutableModelStats {
  model: string;
  calls: number;
  success: number;
  latencyTotal: number;
  tokens: number;
  spend: number;
}

function startOfLocalDay(value: Date): Date {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
    0,
    0,
    0,
    0,
  );
}

function dayKey(value: Date): string {
  return formatLocalDate(value);
}

function toSafeNumber(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return value;
}

function toPositiveInt(value: unknown): number {
  return Math.max(0, Math.round(toSafeNumber(value)));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function resolveModelName(log: ProxyLogLike): string {
  const raw = (log.modelActual || log.modelRequested || '').trim();
  return raw.length > 0 ? raw : 'unknown';
}

export function resolveModelAnalysisSpend(
  log: Pick<ProxyLogLike, 'estimatedCost'>,
  tokens: number,
): number {
  const explicit = toSafeNumber(log.estimatedCost);
  if (explicit > 0) return explicit;
  if (tokens <= 0) return 0;
  return tokens / 500000;
}

function finalizeModelAnalysis(
  stats: MutableModelStats[],
  dayKeys: string[],
  spendTrendMap: Map<string, number>,
  maxModels: number,
): ModelAnalysisResult {
  const totalCalls = stats.reduce((sum, item) => sum + item.calls, 0);
  const totalTokens = stats.reduce((sum, item) => sum + item.tokens, 0);
  const totalSpend = round(stats.reduce((sum, item) => sum + item.spend, 0), 6);

  const spendDistribution = [...stats]
    .sort((a, b) => b.spend - a.spend)
    .slice(0, maxModels)
    .map((item) => ({
      model: item.model,
      spend: round(item.spend, 6),
      calls: item.calls,
    }));

  const callsDistribution = [...stats]
    .sort((a, b) => b.calls - a.calls)
    .slice(0, maxModels)
    .map((item) => ({
      model: item.model,
      calls: item.calls,
      share: totalCalls > 0 ? round((item.calls / totalCalls) * 100, 2) : 0,
    }));

  const callRanking = [...stats]
    .sort((a, b) => b.calls - a.calls)
    .slice(0, maxModels)
    .map((item) => ({
      model: item.model,
      calls: item.calls,
      successRate: item.calls > 0 ? round((item.success / item.calls) * 100, 2) : 0,
      avgLatencyMs: item.calls > 0 ? Math.round(item.latencyTotal / item.calls) : 0,
      spend: round(item.spend, 6),
      tokens: item.tokens,
    }));

  const spendTrend = dayKeys.map((day) => ({
    day,
    spend: round(spendTrendMap.get(day) ?? 0, 6),
  }));

  return {
    window: {
      start: dayKeys[0],
      end: dayKeys[dayKeys.length - 1],
      days: dayKeys.length,
    },
    totals: {
      calls: totalCalls,
      tokens: totalTokens,
      spend: totalSpend,
    },
    spendDistribution,
    spendTrend,
    callsDistribution,
    callRanking,
  };
}

export function buildModelAnalysis(
  logs: ProxyLogLike[],
  options: BuildOptions = {},
): ModelAnalysisResult {
  const now = options.now ?? new Date();
  const days = Math.max(1, options.days ?? 7);
  const maxModels = Math.max(1, options.maxModels ?? 10);

  const endDay = startOfLocalDay(now);
  const startDay = new Date(endDay.getTime() - (days - 1) * DAY_MS);
  const dayKeys: string[] = [];
  for (let i = 0; i < days; i += 1) {
    dayKeys.push(dayKey(new Date(startDay.getTime() + i * DAY_MS)));
  }

  const daySet = new Set(dayKeys);
  const spendTrendMap = new Map<string, number>(dayKeys.map((key) => [key, 0]));
  const modelMap = new Map<string, MutableModelStats>();

  for (const log of logs) {
    if (!log?.createdAt) continue;
    const createdAt = parseStoredUtcDateTime(log.createdAt);
    if (!createdAt) continue;

    const createdAtDay = dayKey(createdAt);
    if (!daySet.has(createdAtDay)) continue;

    const model = resolveModelName(log);
    const tokens = toPositiveInt(log.totalTokens);
    const spend = Math.max(0, resolveModelAnalysisSpend(log, tokens));
    const latency = toPositiveInt(log.latencyMs);
    const isSuccess = (log.status || '').toLowerCase() === 'success';

    const stat = modelMap.get(model) ?? {
      model,
      calls: 0,
      success: 0,
      latencyTotal: 0,
      tokens: 0,
      spend: 0,
    };

    stat.calls += 1;
    stat.success += isSuccess ? 1 : 0;
    stat.latencyTotal += latency;
    stat.tokens += tokens;
    stat.spend += spend;
    modelMap.set(model, stat);

    spendTrendMap.set(createdAtDay, (spendTrendMap.get(createdAtDay) ?? 0) + spend);
  }

  return finalizeModelAnalysis(Array.from(modelMap.values()), dayKeys, spendTrendMap, maxModels);
}

export function buildModelAnalysisFromDailyUsage(
  rows: ModelAnalysisDailyUsageRow[],
  options: BuildOptions = {},
): ModelAnalysisResult {
  const now = options.now ?? new Date();
  const days = Math.max(1, options.days ?? 7);
  const maxModels = Math.max(1, options.maxModels ?? 10);

  const endDay = startOfLocalDay(now);
  const startDay = new Date(endDay.getTime() - (days - 1) * DAY_MS);
  const dayKeys: string[] = [];
  for (let i = 0; i < days; i += 1) {
    dayKeys.push(dayKey(new Date(startDay.getTime() + i * DAY_MS)));
  }

  const daySet = new Set(dayKeys);
  const spendTrendMap = new Map<string, number>(dayKeys.map((key) => [key, 0]));
  const modelMap = new Map<string, MutableModelStats>();

  for (const row of rows) {
    const aggregateDay = String(row.localDay || '').trim();
    if (!daySet.has(aggregateDay)) continue;

    const model = String(row.model || '').trim() || 'unknown';
    const calls = toPositiveInt(row.totalCalls);
    const successCount = toPositiveInt(row.successCalls);
    const tokens = toPositiveInt(row.totalTokens);
    const spend = Math.max(0, toSafeNumber(row.totalSpend));
    const latencyTotal = toPositiveInt(row.totalLatencyMs);

    const stat = modelMap.get(model) ?? {
      model,
      calls: 0,
      success: 0,
      latencyTotal: 0,
      tokens: 0,
      spend: 0,
    };

    stat.calls += calls;
    stat.success += successCount;
    stat.latencyTotal += latencyTotal;
    stat.tokens += tokens;
    stat.spend += spend;
    modelMap.set(model, stat);

    spendTrendMap.set(aggregateDay, (spendTrendMap.get(aggregateDay) ?? 0) + spend);
  }

  return finalizeModelAnalysis(Array.from(modelMap.values()), dayKeys, spendTrendMap, maxModels);
}
