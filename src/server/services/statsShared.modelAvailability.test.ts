import { describe, expect, it } from 'vitest';
import { buildModelAvailabilitySummaries } from './statsShared.js';

describe('buildModelAvailabilitySummaries', () => {
  it('aggregates 24h buckets by model', () => {
    const now = new Date(2026, 2, 11, 12, 30, 0);
    const hour = (offset: number) => {
      const d = new Date(2026, 2, 11, 12 + offset, 15, 0);
      return d.toISOString();
    };
    const rows = [
      { model: 'gpt-4o', createdAt: hour(0), status: 'success', latencyMs: 100 },
      { model: 'gpt-4o', createdAt: hour(0), status: 'failed', latencyMs: 200 },
      { model: 'claude', createdAt: hour(-1), status: 'success', latencyMs: 300 },
      { model: '', createdAt: hour(0), status: 'success', latencyMs: 50 },
    ];
    const result = buildModelAvailabilitySummaries(rows, now);
    expect(result.map((row) => row.model)).toEqual(['gpt-4o', 'claude']);
    expect(result[0]).toMatchObject({
      model: 'gpt-4o',
      totalRequests: 2,
      successCount: 1,
      failedCount: 1,
      availabilityPercent: 50,
    });
    expect(result[0].buckets).toHaveLength(24);
  });

  it('merges case, vendor prefix and free-label aliases via canonicalizeModelName', () => {
    const now = new Date(2026, 2, 11, 12, 30, 0);
    const hour = (offset: number) => {
      const d = new Date(2026, 2, 11, 12 + offset, 15, 0);
      return d.toISOString();
    };
    const rows = [
      { model: 'GROK-4.5', createdAt: hour(0), status: 'success', latencyMs: 100 },
      { model: 'grok-4.5', createdAt: hour(0), status: 'failed', latencyMs: 200 },
      { model: 'deepseek/deepseek-v4-pro', createdAt: hour(0), status: 'success', latencyMs: 120 },
      { model: 'deepseek/deepseek-v4-pro:free', createdAt: hour(0), status: 'success', latencyMs: 130 },
      { model: 'deepseek-ai/deepseek-v4-pro', createdAt: hour(0), status: 'failed', latencyMs: 140 },
    ];
    const result = buildModelAvailabilitySummaries(rows, now);
    expect(result.map((row) => row.model).sort()).toEqual([
      'deepseek-v4-pro',
      'grok-4.5',
    ]);
    expect(result.find((row) => row.model === 'grok-4.5')).toMatchObject({
      totalRequests: 2,
      successCount: 1,
      failedCount: 1,
    });
    expect(result.find((row) => row.model === 'deepseek-v4-pro')).toMatchObject({
      totalRequests: 3,
      successCount: 2,
      failedCount: 1,
    });
  });
});
