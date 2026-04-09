import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatUtcSqlDateTime } from "./localTimeService.js";

type DbModule = typeof import("../db/index.js");
type ProjectorModule = typeof import("./usageAggregationService.js");

describe("usageAggregationService", () => {
  let db: DbModule["db"];
  let schema: DbModule["schema"];
  let runUsageAggregationProjectionPass: ProjectorModule["runUsageAggregationProjectionPass"];
  let requestUsageAggregatesRecompute: ProjectorModule["requestUsageAggregatesRecompute"];
  let dataDir = "";
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "metapi-usage-projector-"));
    process.env.DATA_DIR = dataDir;

    await import("../db/migrate.js");
    const dbModule = await import("../db/index.js");
    const projectorModule = await import("./usageAggregationService.js");
    db = dbModule.db;
    schema = dbModule.schema;
    runUsageAggregationProjectionPass = projectorModule.runUsageAggregationProjectionPass;
    requestUsageAggregatesRecompute = projectorModule.requestUsageAggregatesRecompute;
  });

  beforeEach(async () => {
    await db.delete(schema.analyticsProjectionCheckpoints).run();
    await db.delete(schema.modelDayUsage).run();
    await db.delete(schema.siteHourUsage).run();
    await db.delete(schema.siteDayUsage).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("projects proxy logs into day/hour/model aggregates and supports recompute requests", async () => {
    const site = await db
      .insert(schema.sites)
      .values({
        name: "agg-site",
        url: "https://agg.example.com",
        platform: "new-api",
        status: "active",
      })
      .returning()
      .get();
    const account = await db
      .insert(schema.accounts)
      .values({
        siteId: site.id,
        username: "agg-user",
        accessToken: "agg-token",
        status: "active",
      })
      .returning()
      .get();

    await db.insert(schema.proxyLogs).values([
      {
        accountId: account.id,
        status: "success",
        modelRequested: "gpt-5",
        modelActual: "gpt-5",
        totalTokens: 100,
        estimatedCost: 0.2,
        latencyMs: 120,
        createdAt: formatUtcSqlDateTime(new Date("2026-04-08T02:10:00.000Z")),
      },
      {
        accountId: account.id,
        status: "failed",
        modelRequested: "gpt-5-mini",
        modelActual: "gpt-5-mini",
        totalTokens: 50,
        estimatedCost: 0.1,
        latencyMs: 80,
        createdAt: formatUtcSqlDateTime(new Date("2026-04-08T02:45:00.000Z")),
      },
    ]).run();

    const firstPass = await runUsageAggregationProjectionPass();
    expect(firstPass.processedLogs).toBe(2);

    const dayRows = await db.select().from(schema.siteDayUsage).all();
    expect(dayRows).toHaveLength(1);
    expect(dayRows[0]).toEqual(
      expect.objectContaining({
        siteId: site.id,
        totalCalls: 2,
        successCalls: 1,
        failedCalls: 1,
        totalTokens: 150,
      }),
    );
    expect(dayRows[0].totalSummarySpend).toBeCloseTo(0.3, 6);
    expect(dayRows[0].totalSiteSpend).toBeCloseTo(0.3, 6);

    const hourRows = await db.select().from(schema.siteHourUsage).all();
    expect(hourRows).toHaveLength(1);
    expect(hourRows[0]).toEqual(
      expect.objectContaining({
        siteId: site.id,
        totalCalls: 2,
        successCalls: 1,
        failedCalls: 1,
      }),
    );

    const modelRows = await db.select().from(schema.modelDayUsage).all();
    expect(modelRows).toHaveLength(2);

    await db.insert(schema.proxyLogs).values({
      accountId: account.id,
      status: "success",
      modelRequested: "gpt-5",
      modelActual: "gpt-5",
      totalTokens: 20,
      estimatedCost: 0.04,
      latencyMs: 60,
      createdAt: formatUtcSqlDateTime(new Date("2026-04-08T02:50:00.000Z")),
    }).run();

    const secondPass = await runUsageAggregationProjectionPass();
    expect(secondPass.processedLogs).toBe(1);

    const updatedDayRows = await db.select().from(schema.siteDayUsage).all();
    expect(updatedDayRows[0]).toEqual(
      expect.objectContaining({
        siteId: site.id,
        totalCalls: 3,
        successCalls: 2,
        failedCalls: 1,
        totalTokens: 170,
      }),
    );
    expect(updatedDayRows[0].totalSummarySpend).toBeCloseTo(0.34, 6);
    expect(updatedDayRows[0].totalSiteSpend).toBeCloseTo(0.34, 6);

    await requestUsageAggregatesRecompute(1);
    const recomputePass = await runUsageAggregationProjectionPass();
    expect(recomputePass.recomputed).toBe(true);

    const recomputedDayRows = await db.select().from(schema.siteDayUsage).all();
    expect(recomputedDayRows[0]).toEqual(
      expect.objectContaining({
        siteId: site.id,
        totalCalls: 3,
        successCalls: 2,
        failedCalls: 1,
        totalTokens: 170,
      }),
    );
    expect(recomputedDayRows[0].totalSummarySpend).toBeCloseTo(0.34, 6);
    expect(recomputedDayRows[0].totalSiteSpend).toBeCloseTo(0.34, 6);
  });

  it("skips projection while another process lease is active and clears lease after success", async () => {
    const site = await db
      .insert(schema.sites)
      .values({
        name: "leased-site",
        url: "https://leased.example.com",
        platform: "new-api",
        status: "active",
      })
      .returning()
      .get();
    const account = await db
      .insert(schema.accounts)
      .values({
        siteId: site.id,
        username: "leased-user",
        accessToken: "leased-token",
        status: "active",
      })
      .returning()
      .get();

    await db.insert(schema.proxyLogs).values({
      accountId: account.id,
      status: "success",
      modelRequested: "gpt-5",
      modelActual: "gpt-5",
      totalTokens: 10,
      estimatedCost: 0.02,
      latencyMs: 50,
      createdAt: formatUtcSqlDateTime(new Date("2026-04-08T03:00:00.000Z")),
    }).run();

    await db.insert(schema.analyticsProjectionCheckpoints).values({
      projectorKey: "usage-aggregates-v1",
      timeZone: "Local",
      lastProxyLogId: 0,
      leaseOwner: "other-process",
      leaseToken: "other-token",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).run();

    const blockedPass = await runUsageAggregationProjectionPass();
    expect(blockedPass.processedLogs).toBe(0);
    expect(await db.select().from(schema.siteDayUsage).all()).toHaveLength(0);

    await db
      .update(schema.analyticsProjectionCheckpoints)
      .set({
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .where(eq(schema.analyticsProjectionCheckpoints.projectorKey, "usage-aggregates-v1"))
      .run();

    const successfulPass = await runUsageAggregationProjectionPass();
    expect(successfulPass.processedLogs).toBe(1);

    const checkpoint = await db
      .select()
      .from(schema.analyticsProjectionCheckpoints)
      .where(eq(schema.analyticsProjectionCheckpoints.projectorKey, "usage-aggregates-v1"))
      .get();
    expect(checkpoint?.leaseOwner).toBeNull();
    expect(checkpoint?.leaseToken).toBeNull();
    expect(checkpoint?.leaseExpiresAt).toBeNull();
    expect(checkpoint?.lastError).toBeNull();
  });
});
