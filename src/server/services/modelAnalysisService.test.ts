import { describe, expect, it } from 'vitest';
import { buildModelAnalysis, buildModelAnalysisFromDailyUsage } from './modelAnalysisService.js';
import { formatLocalDate } from './localTimeService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('buildModelAnalysis', () => {
  it('aggregates spend/calls data in a rolling day window', () => {
    const logs = [
      {
        createdAt: '2026-02-24T02:00:00.000Z',
        modelActual: 'gpt-4o',
        modelRequested: null,
        status: 'success',
        latencyMs: 800,
        totalTokens: 1000,
        estimatedCost: 1.25,
      },
      {
        createdAt: '2026-02-24T06:00:00.000Z',
        modelActual: null,
        modelRequested: 'gpt-4o',
        status: 'failed',
        latencyMs: 1200,
        totalTokens: 300,
        estimatedCost: 0.25,
      },
      {
        createdAt: '2026-02-23T08:00:00.000Z',
        modelActual: 'claude-3-5-sonnet',
        modelRequested: null,
        status: 'success',
        latencyMs: 500,
        totalTokens: 2000,
        estimatedCost: 2,
      },
      {
        createdAt: '2026-02-19T10:00:00.000Z',
        modelActual: 'gpt-4.1-mini',
        modelRequested: null,
        status: 'success',
        latencyMs: 200,
        totalTokens: 120,
        estimatedCost: 0.08,
      },
    ];

    const now = new Date('2026-02-24T12:00:00.000Z');
    const result = buildModelAnalysis(logs, {
      now,
      days: 3,
    });

    const endDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const startDay = new Date(endDay.getTime() - 2 * DAY_MS);
    const dayKeys = Array.from({ length: 3 }, (_, index) =>
      formatLocalDate(new Date(startDay.getTime() + index * DAY_MS)),
    );
    const daySet = new Set(dayKeys);
    const spendByDay = new Map<string, number>(dayKeys.map((key) => [key, 0]));
    for (const log of logs) {
      const createdAt = new Date(log.createdAt);
      const dayKey = formatLocalDate(createdAt);
      if (!daySet.has(dayKey)) continue;
      spendByDay.set(dayKey, (spendByDay.get(dayKey) ?? 0) + (log.estimatedCost ?? 0));
    }

    expect(result.window).toEqual({
      start: dayKeys[0],
      end: dayKeys[dayKeys.length - 1],
      days: 3,
    });
    expect(result.totals.calls).toBe(3);
    expect(result.totals.tokens).toBe(3300);
    expect(result.totals.spend).toBe(3.5);
    expect(result.spendTrend).toEqual(dayKeys.map((day) => ({
      day,
      spend: spendByDay.get(day) ?? 0,
    })));
    expect(result.callRanking[0]).toMatchObject({
      model: 'gpt-4o',
      calls: 2,
      successRate: 50,
    });
  });

  it('normalizes unknown model names and invalid numbers', () => {
    const logs = [
      {
        createdAt: '2026-02-24T12:00:00.000Z',
        modelActual: null,
        modelRequested: null,
        status: 'success',
        latencyMs: null,
        totalTokens: null,
        estimatedCost: null,
      },
      {
        createdAt: 'invalid-date',
        modelActual: 'gpt-4o',
        modelRequested: null,
        status: 'success',
        latencyMs: 10,
        totalTokens: 10,
        estimatedCost: 1,
      },
    ];

    const result = buildModelAnalysis(logs, {
      now: new Date('2026-02-24T12:00:00.000Z'),
      days: 1,
    });

    expect(result.totals).toEqual({
      calls: 1,
      tokens: 0,
      spend: 0,
    });
    expect(result.callsDistribution[0]).toMatchObject({
      model: 'unknown',
      calls: 1,
      share: 100,
    });
  });

  it('falls back to token-based spend estimation when estimatedCost is missing', () => {
    const logs = [
      {
        createdAt: '2026-02-24T12:30:00.000Z',
        modelActual: 'gpt-4o-mini',
        modelRequested: null,
        status: 'success',
        latencyMs: 120,
        totalTokens: 1000,
        estimatedCost: null,
      },
    ];

    const result = buildModelAnalysis(logs, {
      now: new Date('2026-02-24T12:00:00.000Z'),
      days: 1,
    });

    expect(result.totals.spend).toBe(0.002);
    expect(result.spendDistribution[0]).toMatchObject({
      model: 'gpt-4o-mini',
      spend: 0.002,
      calls: 1,
    });
  });

  it('merges DeepSeek V4 Flash aliases in raw and daily dashboard statistics', () => {
    const now = new Date('2026-02-24T12:00:00.000Z');
    const logBase = {
      createdAt: '2026-02-24T10:00:00.000Z',
      modelRequested: null,
      status: 'success',
      latencyMs: 100,
      totalTokens: 100,
      estimatedCost: 0.1,
    };
    const raw = buildModelAnalysis([
      { ...logBase, modelActual: 'deepseek-v4-flash' },
      { ...logBase, modelActual: 'DeepSeek-V4-Flash' },
      { ...logBase, modelActual: 'deepseek-v4-flash-free' },
    ], { now, days: 1 });

    expect(raw.callRanking).toHaveLength(1);
    expect(raw.callRanking[0]).toMatchObject({ model: 'deepseek-v4-flash', calls: 3 });

    const daily = buildModelAnalysisFromDailyUsage([
      { localDay: '2026-02-24', model: 'deepseek-v4-flash', totalCalls: 1, successCalls: 1, totalTokens: 100, totalSpend: 0.1, totalLatencyMs: 100 },
      { localDay: '2026-02-24', model: 'DeepSeek-V4-Flash', totalCalls: 2, successCalls: 2, totalTokens: 200, totalSpend: 0.2, totalLatencyMs: 200 },
      { localDay: '2026-02-24', model: 'deepseek-v4-flash-free', totalCalls: 3, successCalls: 3, totalTokens: 300, totalSpend: 0.3, totalLatencyMs: 300 },
    ], { now, days: 1 });

    expect(daily.callRanking).toHaveLength(1);
    expect(daily.callRanking[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      calls: 6,
      tokens: 600,
      spend: 0.6,
    });
  });

  it('accepts Date-backed createdAt values from external database drivers', () => {
    const logs = [
      {
        createdAt: new Date('2026-02-24T12:30:00.000Z') as unknown as string,
        modelActual: 'gpt-4o',
        modelRequested: null,
        status: 'success',
        latencyMs: 250,
        totalTokens: 800,
        estimatedCost: 1.6,
      },
    ];

    const result = buildModelAnalysis(logs, {
      now: new Date('2026-02-24T12:00:00.000Z'),
      days: 1,
    });

    expect(result.totals).toEqual({
      calls: 1,
      tokens: 800,
      spend: 1.6,
    });
    expect(result.callRanking[0]).toMatchObject({
      model: 'gpt-4o',
      calls: 1,
      successRate: 100,
      avgLatencyMs: 250,
    });
  });
});
