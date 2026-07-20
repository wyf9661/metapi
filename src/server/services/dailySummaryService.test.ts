import { describe, expect, it } from 'vitest';
import {
  buildDailySummaryNotification,
  summarizeSiteCheckinOutcomes,
  type DailySummaryMetrics,
} from './dailySummaryService.js';

describe('dailySummaryService', () => {
  it('builds readable daily summary notification text', () => {
    const metrics: DailySummaryMetrics = {
      localDay: '2026-02-27',
      generatedAtLocal: '2026-02-27 23:58:00',
      timeZone: 'Asia/Shanghai',
      totalAccounts: 10,
      activeAccounts: 8,
      lowBalanceAccounts: 2,
      checkinTotal: 7,
      checkinSuccess: 5,
      checkinSkipped: 0,
      checkinFailed: 2,
      proxyTotal: 120,
      proxySuccess: 114,
      proxyFailed: 6,
      proxyTotalTokens: 987654,
      todaySpend: 12.345678,
      todayReward: 3.210987,
    };

    const { title, message } = buildDailySummaryNotification(metrics);
    expect(title).toBe('每日总结 2026-02-27');
    expect(message).toContain('生成时间: 2026-02-27 23:58:00 (Asia/Shanghai)');
    expect(message).toContain('签到统计(按站点): 总计 7 | 成功 5 | 失败 2');
    expect(message).toContain('代理统计: 总计 120 | 成功 114 | 失败 6');
    expect(message).toContain('费用统计: 支出 $12.345678 | 奖励 $3.210987 | 净值 $-9.134691');
  });

  it('counts checkins by site, not by attempt logs', () => {
    const summary = summarizeSiteCheckinOutcomes([
      { siteId: 1, status: 'success' },
      { siteId: 1, status: 'skipped' },
      { siteId: 1, status: 'failed' },
      { siteId: 2, status: 'failed' },
      { siteId: 2, status: 'failed' },
      { siteId: 3, status: 'skipped' },
    ]);

    // site1: success-like wins; site2: only failed; site3: skipped counts as success
    expect(summary).toEqual({
      total: 3,
      success: 2,
      failed: 1,
    });
  });

  it('keeps failed until a later success/skipped refreshes the site outcome', () => {
    const summary = summarizeSiteCheckinOutcomes([
      { siteId: 9, status: 'failed' },
      { siteId: 9, status: 'success' },
    ]);
    expect(summary).toEqual({ total: 1, success: 1, failed: 0 });
  });
});
