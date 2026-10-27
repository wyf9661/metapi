import { FastifyInstance } from 'fastify';
import { db, schema, runtimeDbDialect } from '../../db/index.js';
import { and, eq } from 'drizzle-orm';
import { parseSiteDisabledModelsPayload } from '../../contracts/siteRoutePayloads.js';
import { parseAccountManualModelsPayload } from '../../contracts/accountsRoutePayloads.js';
import { invalidateSiteProxyCache } from '../../services/siteProxy.js';
import { invalidateTokenRouterCache } from '../../services/tokenRouter.js';
import { setAccountNewModelPolicy } from '../../services/accountNewModelPolicy.js';
import { rebuildTokenRoutesFromAvailability } from '../../services/modelService.js';
import { clearModelsMarketplaceCache } from './stats.js';
import { rebuildRoutesBestEffort } from '../../services/accountMutationWorkflow.js';
import {
  getNewModelPolicyFromExtraConfig,
  normalizeNewModelPolicy,
} from '../../services/accountExtraConfig.js';

/**
 * Per-account model list and per-key disabled/manual overrides.
 *
 * Extracted from accounts.ts; registered by calling this function directly
 * from accountsRoutes so the Fastify encapsulation context (and every auth
 * hook) stays identical to the parent module.
 */
export function registerAccountModelRoutes(app: FastifyInstance) {
  // Get model list for an account (available models + disabled status at site level)
  app.get<{ Params: { id: string } }>(
    '/api/accounts/:id/models',
    async (request, reply) => {
      const accountId = parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ message: '账号 ID 无效' });
      }

      const account = await db
        .select()
        .from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (!account) {
        return reply.code(404).send({ message: '账号不存在' });
      }

      const siteId = account.accounts.siteId;

      // Get available models for this account
      const modelRows = await db
        .select({
          modelName: schema.modelAvailability.modelName,
          available: schema.modelAvailability.available,
          latencyMs: schema.modelAvailability.latencyMs,
          isManual: schema.modelAvailability.isManual,
        })
        .from(schema.modelAvailability)
        .where(eq(schema.modelAvailability.accountId, accountId))
        .all();

      // Disabled models are keyed per account: only this key's own rows apply.
      const disabledRows = await db
        .select({ modelName: schema.siteDisabledModels.modelName })
        .from(schema.siteDisabledModels)
        .where(and(
          eq(schema.siteDisabledModels.siteId, siteId),
          eq(schema.siteDisabledModels.accountId, accountId),
        ))
        .all();

      const disabledSet = new Set<string>(disabledRows.map((r) => String(r.modelName)));

      // Merge this key's disabled models into the list even when availability
      // no longer reports them, so they stay reachable and can be re-enabled.
      const rowsByName = new Map<string, { latencyMs: unknown; isManual: boolean }>();
      for (const r of modelRows) {
        if (!r.available) continue;
        rowsByName.set(r.modelName, { latencyMs: r.latencyMs, isManual: !!r.isManual });
      }
      for (const modelName of disabledSet) {
        if (!rowsByName.has(modelName)) rowsByName.set(modelName, { latencyMs: null, isManual: false });
      }

      const models = Array.from(rowsByName.entries())
        .map(([name, info]) => ({
          name,
          latencyMs: info.latencyMs,
          disabled: disabledSet.has(name),
          isManual: info.isManual,
        }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));

      return {
        siteId,
        siteName: account.sites.name,
        models,
        totalCount: models.length,
        disabledCount: models.filter((m: any) => m.disabled).length,
        newModelPolicy: getNewModelPolicyFromExtraConfig(account.accounts.extraConfig),
      };
    },
  );

  // Replace the disabled models of one key. Site-wide rows are untouched, and
  // other keys of the same site keep their own sets.
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/accounts/:id/models/disabled',
    async (request, reply) => {
      const accountId = parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ message: '账号 ID 无效' });
      }

      const parsedBody = parseSiteDisabledModelsPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ error: parsedBody.error });
      }

      const account = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (!account) {
        return reply.code(404).send({ message: '账号不存在' });
      }

      const siteId = account.siteId;
      const uniqueModels = Array.from(new Set(
        (parsedBody.data.models as unknown[])
          .filter((m): m is string => typeof m === 'string')
          .map((m) => m.trim())
          .filter((m) => m.length > 0),
      ));

      await db.transaction(async (tx: any) => {
        await tx.delete(schema.siteDisabledModels)
          .where(and(
            eq(schema.siteDisabledModels.siteId, siteId),
            eq(schema.siteDisabledModels.accountId, accountId),
          ))
          .run();

        if (uniqueModels.length > 0) {
          await tx.insert(schema.siteDisabledModels).values(
            uniqueModels.map((modelName) => ({ siteId, accountId, modelName })),
          ).run();
        }
      });

      const rawPolicy = (request.body as { newModelPolicy?: unknown } | null | undefined)?.newModelPolicy;
      const nextPolicy = normalizeNewModelPolicy(rawPolicy);
      if (nextPolicy) {
        await setAccountNewModelPolicy(accountId, nextPolicy);
      }

      invalidateSiteProxyCache();
      invalidateTokenRouterCache();
      clearModelsMarketplaceCache();
      // Drop channels/routes for this key's now-disabled models immediately.
      rebuildTokenRoutesFromAvailability().catch((err) => {
        console.warn('[accounts] rebuild routes after per-key disabled-models update failed', err);
      });

      return { accountId, siteId, models: uniqueModels };
    },
  );

  // Remove manually added models from an account
  app.delete<{ Params: { id: string }; Body: unknown }>(
    '/api/accounts/:id/models/manual',
    async (request, reply) => {
      const parsedBody = parseAccountManualModelsPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ message: parsedBody.error });
      }

      const accountId = parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ message: '账号 ID 无效' });
      }

      const { models } = parsedBody.data;
      if (!Array.isArray(models) || models.length === 0) {
        return reply.code(400).send({ message: '模型列表不能为空' });
      }

      const normalizedModels = Array.from(
        new Set(
          models.map((m) => String(m).trim()).filter((m) => m.length > 0),
        ),
      );
      if (normalizedModels.length === 0) {
        return reply.code(400).send({ message: '模型列表不能为空' });
      }

      const account = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (!account) {
        return reply.code(404).send({ message: '账号不存在' });
      }

      try {
        await db.transaction(async (tx: any) => {
          for (const modelName of normalizedModels) {
            await tx
              .delete(schema.modelAvailability)
              .where(
                and(
                  eq(schema.modelAvailability.accountId, accountId),
                  eq(schema.modelAvailability.modelName, modelName),
                  eq(schema.modelAvailability.isManual, true),
                ),
              )
              .run();
          }
        });
        await rebuildRoutesBestEffort();

        return { success: true };
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        return reply
          .code(500)
          .send({ success: false, message: errMessage || '删除失败' });
      }
    },
  );

  // Add models manually to an account
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/accounts/:id/models/manual',
    async (request, reply) => {
      const parsedBody = parseAccountManualModelsPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ message: parsedBody.error });
      }

      const accountId = parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ message: '账号 ID 无效' });
      }

      const { models } = parsedBody.data;
      if (!Array.isArray(models) || models.length === 0) {
        return reply.code(400).send({ message: '模型列表不能为空' });
      }

      const normalizedModels = Array.from(
        new Set(
          models.map((m) => String(m).trim()).filter((m) => m.length > 0),
        ),
      );
      if (normalizedModels.length === 0) {
        return reply.code(400).send({ message: '模型列表不能为空' });
      }

      const account = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (!account) {
        return reply.code(404).send({ message: '账号不存在' });
      }

      try {
        await db.transaction(async (tx: any) => {
          const checkedAt = new Date().toISOString();
          for (const modelName of normalizedModels) {
            if (runtimeDbDialect === 'mysql') {
              const existing = await tx
                .select()
                .from(schema.modelAvailability)
                .where(
                  and(
                    eq(schema.modelAvailability.accountId, accountId),
                    eq(schema.modelAvailability.modelName, modelName),
                  ),
                )
                .get();

              if (existing) {
                await tx
                  .update(schema.modelAvailability)
                  .set({
                    available: true,
                    latencyMs: null,
                    isManual: true,
                    checkedAt,
                  })
                  .where(eq(schema.modelAvailability.id, existing.id))
                  .run();
              } else {
                await tx
                  .insert(schema.modelAvailability)
                  .values({
                    accountId,
                    modelName,
                    available: true,
                    isManual: true,
                    latencyMs: null,
                    checkedAt,
                  })
                  .run();
              }
            } else {
              // SQLite / PostgreSQL path
              await (
                tx.insert(schema.modelAvailability).values({
                  accountId,
                  modelName,
                  available: true,
                  isManual: true,
                  latencyMs: null,
                  checkedAt,
                }) as any
              )
                .onConflictDoUpdate({
                  target: [
                    schema.modelAvailability.accountId,
                    schema.modelAvailability.modelName,
                  ],
                  set: {
                    available: true,
                    isManual: true,
                    latencyMs: null,
                    checkedAt,
                  },
                })
                .run();
            }
          }
        });
        await rebuildRoutesBestEffort();

        return { success: true };
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        return reply
          .code(500)
          .send({ success: false, message: errMessage || '保存失败' });
      }
    },
  );
}
