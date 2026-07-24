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
});
