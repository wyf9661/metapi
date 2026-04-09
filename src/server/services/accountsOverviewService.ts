import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  getCredentialModeFromExtraConfig,
  hasOauthProvider,
  type AccountCredentialMode,
} from "./accountExtraConfig.js";
import {
  buildRuntimeHealthForAccount,
  type RuntimeHealthInfo,
} from "./accountHealthService.js";
import { parseCheckinRewardAmount } from "./checkinRewardParser.js";
import { getLocalDayRangeUtc } from "./localTimeService.js";
import {
  readSnapshotCache,
  type SnapshotEnvelope,
} from "./snapshotCacheService.js";
import { estimateRewardWithTodayIncomeFallback } from "./todayIncomeRewardService.js";
import { createAdminSnapshotPersistence } from "./adminSnapshotStore.js";

export type AccountCapabilities = {
  canCheckin: boolean;
  canRefreshBalance: boolean;
  proxyOnly: boolean;
};

export type AccountOverviewRow = typeof schema.accounts.$inferSelect & {
  site: typeof schema.sites.$inferSelect;
  credentialMode: AccountCredentialMode;
  capabilities: AccountCapabilities;
  todaySpend: number;
  todayReward: number;
  runtimeHealth: RuntimeHealthInfo;
};

export type AccountsSnapshotPayload = {
  accounts: AccountOverviewRow[];
  sites: Array<typeof schema.sites.$inferSelect>;
};

const ACCOUNTS_SNAPSHOT_TTL_MS = 15_000;
const accountsSnapshotPersistence =
  createAdminSnapshotPersistence<AccountsSnapshotPayload>({
    namespace: "accounts-snapshot",
    key: "all",
  });

function hasSessionTokenValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveStoredCredentialMode(
  account: typeof schema.accounts.$inferSelect,
): AccountCredentialMode {
  const fromConfig = getCredentialModeFromExtraConfig(account.extraConfig);
  if (fromConfig && fromConfig !== "auto") return fromConfig;
  return hasSessionTokenValue(account.accessToken) ? "session" : "apikey";
}

function buildCapabilitiesFromCredentialMode(
  credentialMode: AccountCredentialMode,
  hasSessionToken: boolean,
  oauthIdentity?:
    | string
    | null
    | Pick<
        typeof schema.accounts.$inferSelect,
        "extraConfig" | "oauthProvider"
      >,
): AccountCapabilities {
  if (hasOauthProvider(oauthIdentity)) {
    return {
      canCheckin: false,
      canRefreshBalance: false,
      proxyOnly: true,
    };
  }
  const sessionCapable =
    credentialMode === "session"
      ? hasSessionToken
      : credentialMode === "apikey"
        ? false
        : hasSessionToken;
  return {
    canCheckin: sessionCapable,
    canRefreshBalance: sessionCapable,
    proxyOnly: !sessionCapable,
  };
}

function buildCapabilitiesForAccount(
  account: typeof schema.accounts.$inferSelect,
): AccountCapabilities {
  const credentialMode = resolveStoredCredentialMode(account);
  return buildCapabilitiesFromCredentialMode(
    credentialMode,
    hasSessionTokenValue(account.accessToken),
    account,
  );
}

async function loadAccountsSnapshotPayload(): Promise<AccountsSnapshotPayload> {
  const [rows, sites] = await Promise.all([
    db
      .select()
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .all(),
    db.select().from(schema.sites).all(),
  ]);

  const { localDay, startUtc, endUtc } = getLocalDayRangeUtc();

  const [todaySpendRows, modelCountRows, todayCheckins] = await Promise.all([
    db
      .select({
        accountId: schema.proxyLogs.accountId,
        totalSpend: sql<number>`coalesce(sum(${schema.proxyLogs.estimatedCost}), 0)`,
      })
      .from(schema.proxyLogs)
      .where(
        and(
          gte(schema.proxyLogs.createdAt, startUtc),
          lt(schema.proxyLogs.createdAt, endUtc),
        ),
      )
      .groupBy(schema.proxyLogs.accountId)
      .all(),
    db
      .select({
        accountId: schema.modelAvailability.accountId,
        modelCount: sql<number>`count(*)`,
      })
      .from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.available, true))
      .groupBy(schema.modelAvailability.accountId)
      .all(),
    db
      .select({
        accountId: schema.checkinLogs.accountId,
        reward: schema.checkinLogs.reward,
        message: schema.checkinLogs.message,
      })
      .from(schema.checkinLogs)
      .where(
        and(
          gte(schema.checkinLogs.createdAt, startUtc),
          lt(schema.checkinLogs.createdAt, endUtc),
          eq(schema.checkinLogs.status, "success"),
        ),
      )
      .all(),
  ]);

  const spendByAccount: Record<number, number> = {};
  for (const row of todaySpendRows) {
    if (row.accountId == null) continue;
    spendByAccount[row.accountId] = Number(row.totalSpend || 0);
  }

  const modelCountByAccount: Record<number, number> = {};
  for (const row of modelCountRows) {
    if (row.accountId == null) continue;
    modelCountByAccount[row.accountId] = Number(row.modelCount || 0);
  }

  const rewardByAccount: Record<number, number> = {};
  const successCountByAccount: Record<number, number> = {};
  const parsedRewardCountByAccount: Record<number, number> = {};
  for (const log of todayCheckins) {
    successCountByAccount[log.accountId] =
      (successCountByAccount[log.accountId] || 0) + 1;
    const rewardNum =
      parseCheckinRewardAmount(log.reward) ||
      parseCheckinRewardAmount(log.message);
    if (rewardNum <= 0) continue;
    rewardByAccount[log.accountId] =
      (rewardByAccount[log.accountId] || 0) + rewardNum;
    parsedRewardCountByAccount[log.accountId] =
      (parsedRewardCountByAccount[log.accountId] || 0) + 1;
  }

  return {
    accounts: rows.map((row) => {
      const credentialMode = resolveStoredCredentialMode(row.accounts);
      const capabilities = buildCapabilitiesForAccount(row.accounts);
      return {
        ...row.accounts,
        site: row.sites,
        credentialMode,
        capabilities,
        todaySpend:
          Math.round((spendByAccount[row.accounts.id] || 0) * 1_000_000) /
          1_000_000,
        todayReward:
          Math.round(
            estimateRewardWithTodayIncomeFallback({
              day: localDay,
              successCount: successCountByAccount[row.accounts.id] || 0,
              parsedRewardCount:
                parsedRewardCountByAccount[row.accounts.id] || 0,
              rewardSum: rewardByAccount[row.accounts.id] || 0,
              extraConfig: row.accounts.extraConfig,
            }) * 1_000_000,
          ) / 1_000_000,
        runtimeHealth: buildRuntimeHealthForAccount({
          accountStatus: row.accounts.status,
          siteStatus: row.sites.status,
          extraConfig: row.accounts.extraConfig,
          sessionCapable: capabilities.canRefreshBalance,
          hasDiscoveredModels: (modelCountByAccount[row.accounts.id] || 0) > 0,
        }),
      };
    }),
    sites,
  };
}

export async function getAccountsSnapshot(options?: {
  forceRefresh?: boolean;
}): Promise<SnapshotEnvelope<AccountsSnapshotPayload>> {
  return readSnapshotCache({
    namespace: "accounts-snapshot",
    key: "all",
    ttlMs: ACCOUNTS_SNAPSHOT_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: accountsSnapshotPersistence,
    loader: loadAccountsSnapshotPayload,
  });
}
