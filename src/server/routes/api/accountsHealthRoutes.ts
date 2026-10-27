import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { refreshBalance } from '../../services/balanceService.js';
import {
  buildRuntimeHealthForAccount,
  setAccountRuntimeHealth,
  type RuntimeHealthState,
} from '../../services/accountHealthService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { parseAccountHealthRefreshPayload } from '../../contracts/accountsRoutePayloads.js';
import { buildCapabilitiesForAccount, withTimeout } from './accountsPure.js';

/**
 * Runtime-health refresh for accounts: the per-row probe, the batch executor
 * and the POST /api/accounts/health/refresh route (synchronous `wait` mode and
 * the deduplicated background-task mode).
 *
 * Extracted from accounts.ts; registered by a direct call from accountsRoutes
 * so the Fastify encapsulation context and every auth hook stay identical to
 * the parent module.
 */

type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

type AccountHealthRefreshResult = {
  accountId: number;
  username: string | null;
  siteName: string;
  status: 'success' | 'failed' | 'skipped';
  state: RuntimeHealthState;
  message: string;
};

const ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS = 10_000;

function summarizeAccountHealthRefresh(results: AccountHealthRefreshResult[]) {
  return {
    total: results.length,
    healthy: results.filter((item) => item.state === 'healthy').length,
    unhealthy: results.filter((item) => item.state === 'unhealthy').length,
    degraded: results.filter((item) => item.state === 'degraded').length,
    disabled: results.filter((item) => item.state === 'disabled').length,
    unknown: results.filter((item) => item.state === 'unknown').length,
    success: results.filter((item) => item.status === 'success').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
  };
}

async function refreshRuntimeHealthForRow(
  row: AccountWithSiteRow,
): Promise<AccountHealthRefreshResult> {
  const accountId = row.accounts.id;
  const username = row.accounts.username;
  const siteName = row.sites.name;
  const capabilities = buildCapabilitiesForAccount(row.accounts);

  if (
    (row.accounts.status || 'active') === 'disabled' ||
    (row.sites.status || 'active') === 'disabled'
  ) {
    // Disabled accounts or sites are skipped without stamping their runtime
    // health snapshot, so the last genuine health observation prevails and
    // the disabled account is excluded from site aggregation.
    return {
      accountId,
      username,
      siteName,
      status: 'skipped',
      state: 'disabled',
      message: '账号或站点已禁用',
    };
  }

  if (capabilities.proxyOnly) {
    return {
      accountId,
      username,
      siteName,
      status: 'skipped',
      state: 'unknown',
      message: '仅代理账号不支持会话健康检查',
    };
  }

  try {
    await withTimeout(
      () => refreshBalance(accountId),
      ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS,
      `站点健康检查超时（${Math.max(1, Math.round(ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS / 1000))}s）`,
    );
    const refreshedAccount = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    const runtimeHealth = buildRuntimeHealthForAccount({
      accountStatus: refreshedAccount?.status || row.accounts.status,
      siteStatus: row.sites.status,
      extraConfig: refreshedAccount?.extraConfig ?? row.accounts.extraConfig,
      sessionCapable: capabilities.canRefreshBalance,
    });

    return {
      accountId,
      username,
      siteName,
      status: runtimeHealth.state === 'unhealthy' ? 'failed' : 'success',
      state: runtimeHealth.state,
      message: runtimeHealth.reason,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = String(errorMessage || '健康检查失败');
    const unhealthy = isTokenExpiredError({ message });
    const state = unhealthy ? 'unhealthy' : 'degraded';
    setAccountRuntimeHealth(accountId, {
      state,
      reason: message,
      source: 'health-refresh',
    });
    return {
      accountId,
      username,
      siteName,
      status: 'failed',
      state,
      message,
    };
  }
}

async function executeRefreshAccountRuntimeHealth(accountId?: number) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const targetRows = Number.isFinite(accountId as number)
    ? rows.filter((row: any) => row.accounts.id === accountId)
    : rows;

  const results: AccountHealthRefreshResult[] = [];
  for (const row of targetRows) {
    results.push(await refreshRuntimeHealthForRow(row));
  }

  return {
    summary: summarizeAccountHealthRefresh(results),
    results,
  };
}

export function registerAccountHealthRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>(
    '/api/accounts/health/refresh',
    async (request, reply) => {
      const parsedBody = parseAccountHealthRefreshPayload(request.body);
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ success: false, message: parsedBody.error });
      }

      const accountId = parsedBody.data.accountId;
      const wait = parsedBody.data.wait === true;

      if (wait) {
        const result = await executeRefreshAccountRuntimeHealth(accountId);
        if (accountId && result.summary.total === 0) {
          return reply
            .code(404)
            .send({ success: false, message: '账号不存在' });
        }
        return {
          success: true,
          ...result,
        };
      }

      const taskTitle = accountId
        ? `刷新账号运行健康状态 #${accountId}`
        : '刷新全部账号运行健康状态';
      const dedupeKey = accountId
        ? `refresh-account-runtime-health-${accountId}`
        : 'refresh-all-account-runtime-health';

      const { task, reused } = startBackgroundTask(
        {
          type: 'status',
          title: taskTitle,
          dedupeKey,
          notifyOnFailure: true,
          successMessage: (currentTask) => {
            const summary = (
              currentTask.result as {
                summary?: ReturnType<typeof summarizeAccountHealthRefresh>;
              }
            )?.summary;
            if (!summary) return `${taskTitle}已完成`;
            return `${taskTitle}完成：健康 ${summary.healthy}，异常 ${summary.unhealthy}，禁用 ${summary.disabled}`;
          },
          failureMessage: (currentTask) =>
            `${taskTitle}失败：${currentTask.error || 'unknown error'}`,
        },
        async () => executeRefreshAccountRuntimeHealth(accountId),
      );

      return reply.code(202).send({
        success: true,
        queued: true,
        reused,
        jobId: task.id,
        status: task.status,
        message: reused
          ? '账号运行健康状态刷新进行中，请稍后查看账号列表'
          : '已开始刷新账号运行健康状态，请稍后查看账号列表',
      });
    },
  );
}
