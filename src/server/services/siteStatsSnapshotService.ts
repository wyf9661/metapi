import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getLocalHourRangeStartUtc,
  getLocalRangeStartDayKey,
} from './localTimeService.js';
import {
  readSnapshotCache,
  type SnapshotEnvelope,
} from './snapshotCacheService.js';
import {
  toRoundedMicroNumber,
} from './statsShared.js';
import { createAdminSnapshotPersistence } from './adminSnapshotStore.js';
import {
  runUsageAggregationProjectionPass,
} from './usageAggregationService.js';

export type SiteStatsSnapshotPayload = {
  distribution: Array<{
    siteId: number;
    siteName: string;
    platform: string | null;
    totalBalance: number;
    totalSpend: number;
    avgDailySpend: number;
    accountCount: number;
  }>;
  trend: Array<{
    date: string;
    sites: Record<string, { spend: number; calls: number }>;
  }>;
  granularity: 'hour' | 'day';
  sites: Array<typeof schema.sites.$inferSelect>;
};

const SITE_STATS_TTL_MS = 15_000;

async function loadSiteStatsSnapshotPayload(
  days: number,
): Promise<SiteStatsSnapshotPayload> {
  // Short windows (1-3 days) switch to hourly buckets so the trend line has
  // enough samples; longer windows stay daily.
  const useHourly = days <= 3;
  const sinceDay = getLocalRangeStartDayKey(days);
  const sinceHourUtc = getLocalHourRangeStartUtc(days * 24);
  await runUsageAggregationProjectionPass();

  const [spendRows, trendRows, sites, accountDistributionRows] =
    await Promise.all([
    db
      .select({
        siteId: schema.siteDayUsage.siteId,
        totalSpend: sql<number>`coalesce(sum(${schema.siteDayUsage.totalSiteSpend}), 0)`,
      })
      .from(schema.siteDayUsage)
      .groupBy(schema.siteDayUsage.siteId)
      .all(),
    useHourly
      ? db
          .select()
          .from(schema.siteHourUsage)
          .where(sql`${schema.siteHourUsage.bucketStartUtc} >= ${sinceHourUtc}`)
          .all()
      : db
          .select()
          .from(schema.siteDayUsage)
          .where(sql`${schema.siteDayUsage.localDay} >= ${sinceDay}`)
          .all(),
    db
      .select()
      .from(schema.sites)
      .where(eq(schema.sites.status, 'active'))
      .all(),
    db
      .select({
        siteId: schema.sites.id,
        siteName: schema.sites.name,
        platform: schema.sites.platform,
        totalBalance: sql<number>`coalesce(sum(coalesce(${schema.accounts.balance}, 0)), 0)`,
        accountCount: sql<number>`count(*)`,
      })
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .groupBy(schema.sites.id, schema.sites.name, schema.sites.platform)
      .all(),
  ]);

  const spendBySiteId = new Map<number, number>();
  for (const row of spendRows) {
    if (row.siteId == null) continue;
    spendBySiteId.set(row.siteId, Number(row.totalSpend || 0));
  }

  const distribution = accountDistributionRows.map((row: any) => {
    const totalSpend = spendBySiteId.get(row.siteId) || 0;
    return {
      siteId: row.siteId,
      siteName: row.siteName,
      platform: row.platform,
      totalBalance: toRoundedMicroNumber(Number(row.totalBalance || 0)),
      totalSpend: toRoundedMicroNumber(totalSpend),
      avgDailySpend: toRoundedMicroNumber(totalSpend / Math.max(1, days)),
      accountCount: Number(row.accountCount || 0),
    };
  });

  const siteFrame: Record<
    string,
    Record<string, { spend: number; calls: number }>
  > = {};
  const activeSiteById = new Map<number, (typeof schema.sites.$inferSelect)>(
    sites.map((site: any) => [site.id, site]),
  );
  for (const row of trendRows) {
    const site = activeSiteById.get(row.siteId);
    if (!site) continue;
    const siteName = site.name || 'unknown';
    // Hourly buckets key on the local hour start; daily rows key on local day.
    const bucket = useHourly ? row.bucketStartUtc : row.localDay;
    if (!bucket) continue;

    if (!siteFrame[bucket]) siteFrame[bucket] = {};
    if (!siteFrame[bucket][siteName])
      siteFrame[bucket][siteName] = { spend: 0, calls: 0 };

    siteFrame[bucket][siteName].spend += Number(row.totalSiteSpend || 0);
    siteFrame[bucket][siteName].calls += Number(row.totalCalls || 0);
  }

  const trend = Object.entries(siteFrame)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({
      date,
      sites: Object.fromEntries(
        Object.entries(value).map(([siteName, stats]) => [
          siteName,
          {
            spend: toRoundedMicroNumber(stats.spend),
            calls: stats.calls,
          },
        ]),
      ),
    }));

  return {
    distribution,
    trend,
    granularity: useHourly ? 'hour' as const : 'day' as const,
    sites,
  };
}

export async function getSiteStatsSnapshot(options?: {
  days?: number;
  forceRefresh?: boolean;
}): Promise<SnapshotEnvelope<SiteStatsSnapshotPayload>> {
  const days = Math.max(1, Math.trunc(options?.days || 7));
  return readSnapshotCache({
    namespace: 'site-stats',
    key: JSON.stringify({ days }),
    ttlMs: SITE_STATS_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: createAdminSnapshotPersistence<SiteStatsSnapshotPayload>({
      namespace: 'site-stats',
      key: JSON.stringify({ days }),
    }),
    loader: async () => loadSiteStatsSnapshotPayload(days),
  });
}
