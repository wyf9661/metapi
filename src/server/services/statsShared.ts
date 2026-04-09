import { sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import {
  formatLocalDateTime,
  getLocalHourAnchor,
  parseStoredUtcDateTime,
  type StoredUtcDateTimeInput,
} from "./localTimeService.js";

export function proxyCostSqlExpression() {
  return sql<number>`
    coalesce(
      ${schema.proxyLogs.estimatedCost},
      case
        when lower(coalesce(${schema.sites.platform}, 'new-api')) = 'veloera'
          then coalesce(${schema.proxyLogs.totalTokens}, 0) / 1000000.0
        else coalesce(${schema.proxyLogs.totalTokens}, 0) / 500000.0
      end
    )
  `;
}

export function toRoundedMicroNumber(value: number | null | undefined): number {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

export function buildProxyLogModelAnalysisSelectFields() {
  return {
    createdAt: schema.proxyLogs.createdAt,
    modelActual: schema.proxyLogs.modelActual,
    modelRequested: schema.proxyLogs.modelRequested,
    status: schema.proxyLogs.status,
    latencyMs: schema.proxyLogs.latencyMs,
    totalTokens: schema.proxyLogs.totalTokens,
    estimatedCost: schema.proxyLogs.estimatedCost,
  };
}

export function buildProxyLogSiteTrendSelectFields() {
  return {
    createdAt: schema.proxyLogs.createdAt,
    estimatedCost: schema.proxyLogs.estimatedCost,
    totalTokens: schema.proxyLogs.totalTokens,
  };
}

const SITE_AVAILABILITY_BUCKET_COUNT = 24;
const SITE_AVAILABILITY_BUCKET_MS = 60 * 60 * 1000;

export type SiteAvailabilitySiteRow = {
  id: number;
  name: string;
  url: string | null;
  platform: string | null;
  sortOrder: number | null;
  isPinned: boolean | null;
};

export type SiteAvailabilityLogRow = {
  siteId: number | null;
  createdAt: StoredUtcDateTimeInput;
  status: string | null;
  latencyMs: number | null;
};

export type SiteAvailabilityHourAggregateRow = {
  siteId: number | null;
  hourStartUtc: StoredUtcDateTimeInput;
  totalRequests: number | null;
  successCount: number | null;
  failedCount: number | null;
  totalLatencyMs: number | null;
  latencyCount: number | null;
};

type SiteAvailabilityBucketAccumulator = {
  startUtc: string;
  label: string;
  totalRequests: number;
  successCount: number;
  failedCount: number;
  latencyTotalMs: number;
  latencyCount: number;
};

function roundPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

function createSiteAvailabilityBucketTemplate(startMs: number) {
  return Array.from({ length: SITE_AVAILABILITY_BUCKET_COUNT }, (_, index) => {
    const bucketStart = new Date(startMs + index * SITE_AVAILABILITY_BUCKET_MS);
    return {
      startUtc: bucketStart.toISOString(),
      label: formatLocalDateTime(bucketStart),
      totalRequests: 0,
      successCount: 0,
      failedCount: 0,
      latencyTotalMs: 0,
      latencyCount: 0,
    } satisfies SiteAvailabilityBucketAccumulator;
  });
}

function createSiteAvailabilityAccumulatorMap(
  sites: SiteAvailabilitySiteRow[],
  startMs: number,
) {
  const siteMap = new Map<
    number,
    {
      site: SiteAvailabilitySiteRow;
      totalRequests: number;
      successCount: number;
      failedCount: number;
      latencyTotalMs: number;
      latencyCount: number;
      buckets: SiteAvailabilityBucketAccumulator[];
    }
  >();

  for (const site of sites) {
    siteMap.set(site.id, {
      site,
      totalRequests: 0,
      successCount: 0,
      failedCount: 0,
      latencyTotalMs: 0,
      latencyCount: 0,
      buckets: createSiteAvailabilityBucketTemplate(startMs),
    });
  }

  return siteMap;
}

function finalizeSiteAvailabilitySummaries(
  sites: SiteAvailabilitySiteRow[],
  siteMap: ReturnType<typeof createSiteAvailabilityAccumulatorMap>,
) {
  return sites.map((site) => {
    const aggregate = siteMap.get(site.id)!;
    return {
      siteId: site.id,
      siteName: site.name,
      siteUrl: site.url,
      platform: site.platform,
      totalRequests: aggregate.totalRequests,
      successCount: aggregate.successCount,
      failedCount: aggregate.failedCount,
      availabilityPercent:
        aggregate.totalRequests > 0
          ? roundPercent((aggregate.successCount / aggregate.totalRequests) * 100)
          : null,
      averageLatencyMs:
        aggregate.latencyCount > 0
          ? Math.round(aggregate.latencyTotalMs / aggregate.latencyCount)
          : null,
      buckets: aggregate.buckets.map((bucket) => ({
        startUtc: bucket.startUtc,
        label: bucket.label,
        totalRequests: bucket.totalRequests,
        successCount: bucket.successCount,
        failedCount: bucket.failedCount,
        availabilityPercent:
          bucket.totalRequests > 0
            ? roundPercent((bucket.successCount / bucket.totalRequests) * 100)
            : null,
        averageLatencyMs:
          bucket.latencyCount > 0
            ? Math.round(bucket.latencyTotalMs / bucket.latencyCount)
            : null,
      })),
    };
  });
}

export function buildSiteAvailabilitySummaries(
  sites: SiteAvailabilitySiteRow[],
  logs: SiteAvailabilityLogRow[],
  now = new Date(),
) {
  const endLocal = getLocalHourAnchor(now);
  const startLocal = new Date(
    endLocal.getTime() -
      (SITE_AVAILABILITY_BUCKET_COUNT - 1) * SITE_AVAILABILITY_BUCKET_MS,
  );
  const startMs = startLocal.getTime();
  const rangeMs = SITE_AVAILABILITY_BUCKET_COUNT * SITE_AVAILABILITY_BUCKET_MS;
  const siteMap = createSiteAvailabilityAccumulatorMap(sites, startMs);

  for (const log of logs) {
    if (log.siteId == null) continue;
    const target = siteMap.get(log.siteId);
    if (!target) continue;

    const parsed = parseStoredUtcDateTime(log.createdAt);
    if (!parsed) continue;
    const diffMs = parsed.getTime() - startMs;
    if (diffMs < 0 || diffMs >= rangeMs) continue;

    const bucketIndex = Math.floor(diffMs / SITE_AVAILABILITY_BUCKET_MS);
    const bucket = target.buckets[bucketIndex];
    const isSuccess = (log.status || "").trim().toLowerCase() === "success";

    target.totalRequests += 1;
    bucket.totalRequests += 1;
    if (isSuccess) {
      target.successCount += 1;
      bucket.successCount += 1;
    } else {
      target.failedCount += 1;
      bucket.failedCount += 1;
    }

    const latencyMs = Number(log.latencyMs);
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      target.latencyTotalMs += latencyMs;
      target.latencyCount += 1;
      bucket.latencyTotalMs += latencyMs;
      bucket.latencyCount += 1;
    }
  }

  return finalizeSiteAvailabilitySummaries(sites, siteMap);
}

export function buildSiteAvailabilitySummariesFromHourlyAggregates(
  sites: SiteAvailabilitySiteRow[],
  rows: SiteAvailabilityHourAggregateRow[],
  now = new Date(),
) {
  const endLocal = getLocalHourAnchor(now);
  const startLocal = new Date(
    endLocal.getTime() -
      (SITE_AVAILABILITY_BUCKET_COUNT - 1) * SITE_AVAILABILITY_BUCKET_MS,
  );
  const startMs = startLocal.getTime();
  const rangeMs = SITE_AVAILABILITY_BUCKET_COUNT * SITE_AVAILABILITY_BUCKET_MS;
  const siteMap = createSiteAvailabilityAccumulatorMap(sites, startMs);

  for (const row of rows) {
    if (row.siteId == null) continue;
    const target = siteMap.get(row.siteId);
    if (!target) continue;

    const parsed = parseStoredUtcDateTime(row.hourStartUtc);
    if (!parsed) continue;
    const diffMs = parsed.getTime() - startMs;
    if (diffMs < 0 || diffMs >= rangeMs) continue;

    const bucketIndex = Math.floor(diffMs / SITE_AVAILABILITY_BUCKET_MS);
    const bucket = target.buckets[bucketIndex];
    const totalRequests = Math.max(0, Number(row.totalRequests || 0));
    const successCount = Math.max(0, Number(row.successCount || 0));
    const failedCount = Math.max(0, Number(row.failedCount || 0));
    const totalLatencyMs = Math.max(0, Number(row.totalLatencyMs || 0));
    const latencyCount = Math.max(0, Number(row.latencyCount || 0));

    target.totalRequests += totalRequests;
    target.successCount += successCount;
    target.failedCount += failedCount;
    target.latencyTotalMs += totalLatencyMs;
    target.latencyCount += latencyCount;

    bucket.totalRequests += totalRequests;
    bucket.successCount += successCount;
    bucket.failedCount += failedCount;
    bucket.latencyTotalMs += totalLatencyMs;
    bucket.latencyCount += latencyCount;
  }

  return finalizeSiteAvailabilitySummaries(sites, siteMap);
}
