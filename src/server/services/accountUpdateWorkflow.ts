import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { startBackgroundTask } from './backgroundTaskService.js';
import {
  convergeAccountMutation,
  rebuildRoutesBestEffort,
} from './accountMutationWorkflow.js';

type AccountUpdateWorkflowInput = {
  accountId: number;
  updates: Partial<typeof schema.accounts.$inferInsert>;
  preferredApiToken?: string | null;
  refreshModels: boolean;
  preserveExpiredStatus?: boolean;
  allowInactiveModelRefresh?: boolean;
  reactivateAfterSuccessfulModelRefresh?: boolean;
  continueOnError?: boolean;
  /**
   * When true the credential-dependent convergence (model refresh + route
   * rebuild) runs in a background task instead of blocking the HTTP response.
   * The metadata write above stays synchronous so the caller still sees the
   * new values. Recovery flows keep this false because they must learn
   * synchronously whether the replacement credential works.
   */
  deferConvergence?: boolean;
};

export async function applyAccountUpdateWorkflow(input: AccountUpdateWorkflowInput) {
  const isExpiredApiKeyRecoveryFlow = Boolean(
    input.preserveExpiredStatus
    && input.allowInactiveModelRefresh
    && input.reactivateAfterSuccessfulModelRefresh,
  );
  const persistedUpdates: Partial<typeof schema.accounts.$inferInsert> = {
    ...input.updates,
    ...(input.preserveExpiredStatus ? { status: 'expired' } : {}),
    updatedAt: new Date().toISOString(),
  };

  await db.update(schema.accounts)
    .set(persistedUpdates)
    .where(eq(schema.accounts.id, input.accountId))
    .run();

  if (input.deferConvergence) {
    // A credential edit used to run model discovery (up to ~30 upstream
    // credential variants on a struggling site) and a full route rebuild
    // inline, so the save button hung for 10-16s. Detach that convergence: the
    // metadata write above already landed, and the background task keeps the
    // dedupe pattern used elsewhere for account mutations.
    const taskTitle = `同步账号变更 #${input.accountId}`;
    startBackgroundTask(
      {
        type: 'account-converge',
        title: taskTitle,
        dedupeKey: `account-converge-${input.accountId}`,
        notifyOnFailure: true,
        successMessage: () => `${taskTitle}已完成`,
        failureMessage: (currentTask) => `${taskTitle}失败：${currentTask.error || 'unknown error'}`,
      },
      async () => {
        await convergeAccountMutation({
          accountId: input.accountId,
          preferredApiToken: input.preferredApiToken,
          defaultTokenSource: 'manual',
          refreshModels: input.refreshModels,
          allowInactiveModelRefresh: input.allowInactiveModelRefresh,
          rebuildRoutes: false,
          continueOnError: true,
        });
        await rebuildRoutesBestEffort();
      },
    );

    const account = await db.select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, input.accountId))
      .get();

    return {
      account,
      convergence: null,
    };
  }

  const convergence = await convergeAccountMutation({
    accountId: input.accountId,
    preferredApiToken: input.preferredApiToken,
    defaultTokenSource: 'manual',
    refreshModels: input.refreshModels,
    allowInactiveModelRefresh: input.allowInactiveModelRefresh,
    rebuildRoutes: false,
    continueOnError: input.continueOnError,
  });

  if (
    input.reactivateAfterSuccessfulModelRefresh
    && convergence.modelRefreshResult?.status === 'success'
  ) {
    await db.update(schema.accounts)
      .set({
        status: 'active',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.accounts.id, input.accountId))
      .run();
  }

  const shouldRebuildRoutes = !isExpiredApiKeyRecoveryFlow
    || convergence.modelRefreshResult?.status === 'success';
  if (shouldRebuildRoutes) {
    await rebuildRoutesBestEffort();
  }

  const account = await db.select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, input.accountId))
    .get();

  return {
    account,
    convergence,
  };
}
