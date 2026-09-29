import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { findDerivedChannelCandidateForRoute } from './patternRouteChannelSyncService.js';
import { clearRouteDecisionSnapshot } from './routeDecisionSnapshotStore.js';
import { invalidateTokenRouterCache } from './tokenRouterRouteCache.js';

export type ResetChannelResult = {
  reset: boolean;
  derived: boolean;
  channel?: typeof schema.routeChannels.$inferSelect;
};

// Undo a manual override in place: write the system's currently derived values
// (token binding, source model, priority/weight, enabled) back onto the SAME
// route_channels row in place, clear the manual flag and request override rules,
// but never touch the accumulated stats. The row is neither deleted nor
// archived, so the table does not grow from this path.
//
// When no derivable default exists (hand-added channel whose account does not
// offer a matching model), the row is left untouched and `derived` is false —
// there is no "default" to restore to, and deleting it would drop its stats.
export async function resetChannelToDerivedState(channelId: number): Promise<ResetChannelResult> {
  const channel = await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.id, channelId))
    .get();
  if (!channel) return { reset: false, derived: false };

  const route = await db.select().from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.id, channel.routeId))
    .get();
  if (!route || !route.modelPattern) return { reset: false, derived: false };

  const candidate = await findDerivedChannelCandidateForRoute(route.modelPattern, {
    accountId: channel.accountId,
    tokenId: channel.tokenId ?? null,
    oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
    sourceModel: channel.sourceModel,
  });
  if (!candidate) return { reset: false, derived: false };

  await db.update(schema.routeChannels)
    .set({
      tokenId: candidate.tokenId,
      oauthRouteUnitId: candidate.oauthRouteUnitId ?? null,
      sourceModel: candidate.sourceModel,
      priority: candidate.priority,
      weight: candidate.weight,
      enabled: candidate.enabled,
      requestOverrideRules: null,
      manualOverride: false,
    })
    .where(eq(schema.routeChannels.id, channel.id))
    .run();

  await clearRouteDecisionSnapshot(route.id);
  invalidateTokenRouterCache();

  const updated = await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.id, channelId))
    .get();
  if (!updated) return { reset: false, derived: false };
  return { reset: true, derived: true, channel: updated };
}
