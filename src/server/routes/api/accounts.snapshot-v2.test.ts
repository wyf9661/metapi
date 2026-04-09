import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatLocalDate,
  formatUtcSqlDateTime,
} from "../../services/localTimeService.js";

type DbModule = typeof import("../../db/index.js");

describe("accounts snapshot v2", () => {
  let app: FastifyInstance;
  let db: DbModule["db"];
  let schema: DbModule["schema"];
  let dataDir = "";
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "metapi-accounts-snapshot-v2-"));
    process.env.DATA_DIR = dataDir;

    await import("../../db/migrate.js");
    const dbModule = await import("../../db/index.js");
    const routesModule = await import("./accounts.js");
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
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

  it("returns accounts and sites in one snapshot payload", async () => {
    const today = formatLocalDate(new Date());
    const site = await db
      .insert(schema.sites)
      .values({
        name: "snapshot-site",
        url: "https://snapshot-site.example.com",
        platform: "new-api",
      })
      .returning()
      .get();

    const account = await db
      .insert(schema.accounts)
      .values({
        siteId: site.id,
        username: "snapshot-user",
        accessToken: "snapshot-token",
        status: "active",
        balance: 18.5,
        extraConfig: JSON.stringify({
          todayIncomeSnapshot: {
            day: today,
            baseline: 3.2,
            latest: 3.2,
            updatedAt: `${today}T08:00:00.000Z`,
          },
        }),
      })
      .returning()
      .get();

    await db
      .insert(schema.proxyLogs)
      .values({
        accountId: account.id,
        status: "success",
        estimatedCost: 1.25,
        createdAt: formatUtcSqlDateTime(new Date()),
      })
      .run();

    await db
      .insert(schema.checkinLogs)
      .values({
        accountId: account.id,
        status: "success",
        reward: "",
        message: "checkin success",
        createdAt: `${today} 09:00:00`,
      })
      .run();

    const response = await app.inject({
      method: "GET",
      url: "/api/accounts",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-accounts-snapshot-cache"]).toBeTruthy();
    const body = response.json() as {
      generatedAt: string;
      accounts: Array<{
        id: number;
        site: { id: number; name: string };
        todaySpend: number;
        todayReward: number;
      }>;
      sites: Array<{ id: number; name: string }>;
    };

    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    expect(body.sites).toEqual([
      expect.objectContaining({ id: site.id, name: "snapshot-site" }),
    ]);
    expect(body.accounts).toEqual([
      expect.objectContaining({
        id: account.id,
        site: expect.objectContaining({ id: site.id, name: "snapshot-site" }),
        todaySpend: 1.25,
        todayReward: 3.2,
      }),
    ]);
  });
});
