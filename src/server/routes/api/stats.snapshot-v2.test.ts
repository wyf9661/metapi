import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatUtcSqlDateTime } from "../../services/localTimeService.js";

type DbModule = typeof import("../../db/index.js");

describe("stats snapshot v2 routes", () => {
  let app: FastifyInstance;
  let db: DbModule["db"];
  let schema: DbModule["schema"];
  let dataDir = "";
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "metapi-stats-snapshot-v2-"));
    process.env.DATA_DIR = dataDir;

    await import("../../db/migrate.js");
    const dbModule = await import("../../db/index.js");
    const routesModule = await import("./stats.js");
    const sitesRoutesModule = await import("./sites.js");
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.statsRoutes);
    await app.register(sitesRoutesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.adminSnapshots).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns dashboard and site snapshot payloads for progressive loading", async () => {
    const recentLogCreatedAt = formatUtcSqlDateTime(new Date());
    const site = await db
      .insert(schema.sites)
      .values({
        name: "stats-site",
        url: "https://stats-site.example.com",
        platform: "new-api",
      })
      .returning()
      .get();
    const account = await db
      .insert(schema.accounts)
      .values({
        siteId: site.id,
        username: "stats-user",
        accessToken: "stats-token",
        balance: 42,
        status: "active",
      })
      .returning()
      .get();

    await db
      .insert(schema.proxyLogs)
      .values([
        {
          accountId: account.id,
          status: "success",
          modelRequested: "gpt-4o",
          modelActual: "gpt-4o",
          totalTokens: 120,
          estimatedCost: 0.5,
          latencyMs: 320,
          createdAt: recentLogCreatedAt,
        },
        {
          accountId: account.id,
          status: "failed",
          modelRequested: "gpt-4o-mini",
          modelActual: "gpt-4o-mini",
          totalTokens: 60,
          estimatedCost: 0.25,
          latencyMs: 220,
          createdAt: recentLogCreatedAt,
        },
        {
          accountId: account.id,
          status: "success",
          modelRequested: "gpt-4.1-mini",
          modelActual: "gpt-4.1-mini",
          totalTokens: 40,
          estimatedCost: 0.1,
          latencyMs: 180,
          createdAt: formatUtcSqlDateTime(
            new Date(Date.now() - (24 * 60 + 30) * 60_000),
          ),
        },
      ])
      .run();

    const summaryResponse = await app.inject({
      method: "GET",
      url: "/api/stats/dashboard?view=summary",
    });
    expect(summaryResponse.statusCode).toBe(200);
    expect(summaryResponse.headers["x-dashboard-summary-cache"]).toBeTruthy();
    const summary = summaryResponse.json() as {
      generatedAt: string;
      totalBalance: number;
      proxy24h: { total: number };
    };
    expect(Date.parse(summary.generatedAt)).not.toBeNaN();
    expect(summary.totalBalance).toBe(42);
    expect(summary.proxy24h.total).toBe(2);

    const insightsResponse = await app.inject({
      method: "GET",
      url: "/api/stats/dashboard?view=insights",
    });
    expect(insightsResponse.statusCode).toBe(200);
    const insights = insightsResponse.json() as {
      generatedAt: string;
      siteAvailability: Array<{ siteId: number }>;
      modelAnalysis: { totals: { calls: number } };
    };
    expect(Date.parse(insights.generatedAt)).not.toBeNaN();
    expect(insights.siteAvailability).toEqual([
      expect.objectContaining({ siteId: site.id }),
    ]);
    expect(insights.modelAnalysis.totals.calls).toBe(3);

    const siteDistributionResponse = await app.inject({
      method: "GET",
      url: "/api/stats/site-distribution?days=7",
    });
    expect(siteDistributionResponse.statusCode).toBe(200);
    const siteDistribution = siteDistributionResponse.json() as {
      distribution: Array<{ siteId: number; totalSpend: number }>;
    };
    expect(siteDistribution.distribution).toEqual([
      expect.objectContaining({ siteId: site.id, totalSpend: 0.85 }),
    ]);

    const siteTrendResponse = await app.inject({
      method: "GET",
      url: "/api/stats/site-trend?days=7",
    });
    expect(siteTrendResponse.statusCode).toBe(200);
    const siteTrend = siteTrendResponse.json() as {
      trend: Array<{ date: string }>;
    };
    expect(siteTrend.trend.length).toBeGreaterThan(0);

    const sitesResponse = await app.inject({
      method: "GET",
      url: "/api/sites",
    });
    expect(sitesResponse.statusCode).toBe(200);
    const sites = sitesResponse.json() as Array<{ id: number; name: string }>;
    expect(sites).toEqual([
      expect.objectContaining({ id: site.id, name: "stats-site" }),
    ]);
  });
});
