import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  getPreferredAccountToken,
  isUsableAccountToken,
} from './accountTokenService.js';
import { clearRouteDecisionSnapshot, clearRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';
import { matchesModelPattern } from './tokenRouter.js';
import { normalizeTokenRouteMode } from '../../shared/tokenRouteContract.js';

type PatternRouteChannelCandidate = {
  tokenId: number | null;
  accountId: number;
  oauthRouteUnitId: number | null;
  sourceModel: string;
  priority: number;
  weight: number;
  enabled: boolean;
};

export type PatternRouteChannelSyncResult = {
  rebuiltRoutes: number;
  routeIds: number[];
  removedChannels: number;
  createdChannels: number;
  // Rows kept in place but re-derived (token/unit/source-model/priority/weight
  // changed) so accumulated stats survive the rebuild.
  updatedChannels: number;
};

type RebuildPatternRouteOptions = {
  excludeExactModelPatterns?: string[];
};

type PatternRouteChannelAffectedRouteSnapshot = {
  modelPattern: string;
  routeMode?: string | null;
};

type SyncPatternRouteChannelsAfterAffectedRouteChangesInput = {
  affectedRouteIds?: number[];
  removedRoutes?: PatternRouteChannelAffectedRouteSnapshot[];
};

type RouteModeModelPattern = {
  modelPattern: string;
  routeMode?: string | null;
};

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

function isPatternGroupRoute(route: RouteModeModelPattern): boolean {
  return normalizeTokenRouteMode(route.routeMode) !== 'explicit_group'
    && !isExactModelPattern(route.modelPattern);
}

function isExactSourceRoute(route: RouteModeModelPattern): boolean {
  return normalizeTokenRouteMode(route.routeMode) !== 'explicit_group'
    && isExactModelPattern(route.modelPattern);
}

function normalizeAffectedRouteIds(routeIds: number[] | undefined): number[] {
  const normalized: number[] = [];
  for (const rawRouteId of routeIds || []) {
    const routeId = Math.trunc(Number(rawRouteId));
    if (!Number.isFinite(routeId) || routeId <= 0 || normalized.includes(routeId)) continue;
    normalized.push(routeId);
  }
  return normalized;
}

function createEmptyPatternRouteChannelSyncResult(): PatternRouteChannelSyncResult {
  return {
    rebuiltRoutes: 0,
    routeIds: [],
    removedChannels: 0,
    createdChannels: 0,
    updatedChannels: 0,
  };
}

function collectRemovedExactModelPatterns(routes: PatternRouteChannelAffectedRouteSnapshot[] | undefined): string[] {
  const normalized: string[] = [];
  for (const route of routes || []) {
    if (!isExactSourceRoute(route)) continue;
    const modelPattern = route.modelPattern.trim();
    const modelKey = normalizeModelKey(modelPattern);
    if (!modelKey || normalized.some((item) => normalizeModelKey(item) === modelKey)) continue;
    normalized.push(modelPattern);
  }
  return normalized;
}

function normalizeModelKey(modelName: string): string {
  return modelName.trim().toLowerCase();
}

function buildChannelPairKey(input: {
  accountId: number;
  tokenId: number | null;
  oauthRouteUnitId?: number | null;
  sourceModel: string | null;
}): string {
  const sourceModel = (input.sourceModel || '').trim().toLowerCase();
  if (typeof input.oauthRouteUnitId === 'number' && Number.isFinite(input.oauthRouteUnitId) && input.oauthRouteUnitId > 0) {
    return `route-unit:${input.oauthRouteUnitId}::${sourceModel}`;
  }
  const tokenId = typeof input.tokenId === 'number' && Number.isFinite(input.tokenId) ? input.tokenId : 0;
  return `account:${input.accountId}::${tokenId}::${sourceModel}`;
}

async function getPatternTokenCandidates(
  modelPattern: string,
  excludedExactModelNames: Set<string>,
): Promise<PatternRouteChannelCandidate[]> {
  const rows = await db.select().from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  const candidates: PatternRouteChannelCandidate[] = [];
  for (const row of rows) {
    if (!isUsableAccountToken(row.account_tokens)) continue;
    const modelName = row.token_model_availability.modelName?.trim();
    if (!modelName) continue;
    if (excludedExactModelNames.has(normalizeModelKey(modelName))) continue;
    if (!matchesModelPattern(modelName, modelPattern)) continue;
    candidates.push({
      tokenId: row.account_tokens.id,
      accountId: row.accounts.id,
      oauthRouteUnitId: null,
      sourceModel: modelName,
      priority: 0,
      weight: 10,
      enabled: true,
    });
  }

  return candidates;
}

async function getMatchedExactRouteChannelCandidates(
  modelPattern: string,
  excludedExactModelNames: Set<string>,
): Promise<{
  candidates: PatternRouteChannelCandidate[];
  exactModelNames: Set<string>;
}> {
  const matchedExactRoutes = (await db.select().from(schema.tokenRoutes).all())
    .filter((route: any) => (
      normalizeTokenRouteMode(route.routeMode) !== 'explicit_group'
      && isExactModelPattern(route.modelPattern)
      && matchesModelPattern(route.modelPattern, modelPattern)
    ));

  const exactModelNames = new Set<string>(excludedExactModelNames);
  for (const route of matchedExactRoutes) {
    exactModelNames.add(normalizeModelKey(route.modelPattern));
  }

  const enabledRoutes = matchedExactRoutes.filter((route: any) => route.enabled);
  if (enabledRoutes.length === 0) {
    return { candidates: [], exactModelNames };
  }

  const routeMap = new Map<number, typeof enabledRoutes[number]>();
  for (const route of enabledRoutes) routeMap.set(route.id, route);

  const channels = await db.select().from(schema.routeChannels)
    .where(inArray(schema.routeChannels.routeId, enabledRoutes.map((route: any) => route.id)))
    .all();

  return {
    exactModelNames,
    candidates: channels.map((channel: any) => ({
      tokenId: channel.tokenId ?? null,
      accountId: channel.accountId,
      oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
      sourceModel: (channel.sourceModel || routeMap.get(channel.routeId)?.modelPattern || '').trim(),
      priority: channel.priority ?? 0,
      weight: channel.weight ?? 10,
      enabled: !!channel.enabled,
    })).filter((candidate: any) => candidate.sourceModel.length > 0),
  };
}

async function collectRouteChannelCandidates(
  modelPattern: string,
  options: RebuildPatternRouteOptions = {},
): Promise<PatternRouteChannelCandidate[]> {
  const excludedExactModelNames = new Set(
    (options.excludeExactModelPatterns || [])
      .map(normalizeModelKey)
      .filter(Boolean),
  );
  const routeCandidates = await getMatchedExactRouteChannelCandidates(modelPattern, excludedExactModelNames);
  const availabilityExclusions = isExactModelPattern(modelPattern)
    ? excludedExactModelNames
    : routeCandidates.exactModelNames;
  const availabilityCandidates = await getPatternTokenCandidates(modelPattern, availabilityExclusions);
  return [...routeCandidates.candidates, ...availabilityCandidates];
}

// The same (account, token, unit, model) pair must never produce two rows; the
// first candidate wins, which keeps the exact-route copies ahead of the
// availability rows exactly like the historical insert order did.
function dedupeRouteChannelCandidates(
  candidates: PatternRouteChannelCandidate[],
): PatternRouteChannelCandidate[] {
  const seen = new Set<string>();
  const deduped: PatternRouteChannelCandidate[] = [];
  for (const candidate of candidates) {
    const key = buildChannelPairKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

async function insertRouteChannelCandidates(
  routeId: number,
  candidates: PatternRouteChannelCandidate[],
): Promise<number> {
  if (candidates.length === 0) return 0;
  // One insert for the whole batch (drizzle chunks it when needed) instead of
  // one statement per channel.
  await db.insert(schema.routeChannels).values(candidates.map((candidate) => ({
    routeId,
    accountId: candidate.accountId,
    tokenId: candidate.tokenId,
    oauthRouteUnitId: candidate.oauthRouteUnitId ?? null,
    sourceModel: candidate.sourceModel,
    priority: candidate.priority,
    weight: candidate.weight,
    enabled: candidate.enabled,
    manualOverride: false,
  }))).run();
  return candidates.length;
}

export async function populateRouteChannelsByModelPattern(
  routeId: number,
  modelPattern: string,
  options: RebuildPatternRouteOptions = {},
): Promise<number> {
  const candidates = dedupeRouteChannelCandidates(await collectRouteChannelCandidates(modelPattern, options));
  if (candidates.length === 0) return 0;

  const existingChannels = await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.routeId, routeId))
    .all();
  const existingPairs = new Set(existingChannels.map((channel: any) => buildChannelPairKey({
    accountId: channel.accountId,
    tokenId: channel.tokenId ?? null,
    oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
    sourceModel: channel.sourceModel,
  })));

  const toInsert = candidates.filter((candidate) => !existingPairs.has(buildChannelPairKey(candidate)));
  return insertRouteChannelCandidates(routeId, toInsert);
}

const MATCH_EXACT_PAIR = 3;
const MATCH_SAME_ACCOUNT_AND_MODEL = 2;
const MATCH_SAME_ACCOUNT = 1;

function channelPairKeyInput(channel: typeof schema.routeChannels.$inferSelect) {
  return {
    accountId: channel.accountId,
    tokenId: channel.tokenId ?? null,
    oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
    sourceModel: channel.sourceModel,
  };
}

// Identity for an automatic channel is the account (plus route unit, when the
// channel belongs to an OAuth pool) and the source model; the token binding is
// a re-derivable attribute. Matching this loosely is what lets a rebuild keep
// the row when a key is rotated or a source model was edited, instead of
// deleting and re-inserting it (which would reset the accumulated stats).
function scoreChannelCandidateMatch(
  channel: typeof schema.routeChannels.$inferSelect,
  candidate: PatternRouteChannelCandidate,
): number {
  if (buildChannelPairKey(channelPairKeyInput(channel)) === buildChannelPairKey(candidate)) {
    return MATCH_EXACT_PAIR;
  }

  const channelUnit = channel.oauthRouteUnitId ?? null;
  const candidateUnit = candidate.oauthRouteUnitId ?? null;
  // Route-unit channels key on the unit, meaning an account identity is not
  // enough to treat two of them as the same channel.
  if (channelUnit !== null || candidateUnit !== null) return 0;

  if (channel.accountId !== candidate.accountId) return 0;
  return normalizeModelKey(channel.sourceModel || '') === normalizeModelKey(candidate.sourceModel || '')
    ? MATCH_SAME_ACCOUNT_AND_MODEL
    : MATCH_SAME_ACCOUNT;
}

export async function rebuildAutomaticRouteChannelsByModelPattern(
  routeId: number,
  modelPattern: string,
  options: RebuildPatternRouteOptions = {},
): Promise<PatternRouteChannelSyncResult> {
  const existingChannels = await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.routeId, routeId))
    .all();

  // Manual overrides are outside the sync's ownership: never removed, never
  // re-derived (that also keeps their stats).
  const autoChannels = existingChannels.filter((channel: { manualOverride: boolean | null }) => (
    !channel.manualOverride
  ));
  const desiredCandidates = dedupeRouteChannelCandidates(
    await collectRouteChannelCandidates(modelPattern, options),
  );

  const scoredPairs: Array<{ score: number; candidateIndex: number; channel: typeof existingChannels[number] }> = [];
  desiredCandidates.forEach((candidate, candidateIndex) => {
    for (const channel of autoChannels) {
      const score = scoreChannelCandidateMatch(channel, candidate);
      if (score <= 0) continue;
      scoredPairs.push({ score, candidateIndex, channel });
    }
  });
  scoredPairs.sort((left, right) => (
    right.score - left.score
    || left.candidateIndex - right.candidateIndex
    || left.channel.id - right.channel.id
  ));

  const matchedCandidateIndexes = new Set<number>();
  const matchedChannelIds = new Set<number>();
  const assignments: Array<{
    candidate: PatternRouteChannelCandidate;
    channel: typeof existingChannels[number];
  }> = [];
  for (const pair of scoredPairs) {
    if (matchedCandidateIndexes.has(pair.candidateIndex) || matchedChannelIds.has(pair.channel.id)) continue;
    matchedCandidateIndexes.add(pair.candidateIndex);
    matchedChannelIds.add(pair.channel.id);
    assignments.push({ candidate: desiredCandidates[pair.candidateIndex], channel: pair.channel });
  }

  let updatedChannels = 0;
  for (const { candidate, channel } of assignments) {
    const derived = {
      tokenId: candidate.tokenId,
      oauthRouteUnitId: candidate.oauthRouteUnitId ?? null,
      sourceModel: candidate.sourceModel,
      priority: candidate.priority,
      weight: candidate.weight,
      enabled: candidate.enabled,
    };
    const changed = channel.tokenId !== derived.tokenId
      || (channel.oauthRouteUnitId ?? null) !== derived.oauthRouteUnitId
      || (channel.sourceModel || '') !== derived.sourceModel
      || (channel.priority ?? 0) !== derived.priority
      || (channel.weight ?? 10) !== derived.weight
      || !!channel.enabled !== derived.enabled;
    if (!changed) continue;
    // In-place re-derive: the row id and every accumulated stat column stay put.
    await db.update(schema.routeChannels)
      .set(derived)
      .where(eq(schema.routeChannels.id, channel.id))
      .run();
    updatedChannels += 1;
  }

  const removableChannels = autoChannels.filter((channel) => !matchedChannelIds.has(channel.id));
  if (removableChannels.length > 0) {
    await db.delete(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, removableChannels.map((channel: { id: number }) => channel.id)))
      .run();
  }

  const createdChannels = await insertRouteChannelCandidates(
    routeId,
    desiredCandidates.filter((_, index) => !matchedCandidateIndexes.has(index)),
  );

  if (removableChannels.length > 0 || createdChannels > 0 || updatedChannels > 0) {
    await clearRouteDecisionSnapshot(routeId);
  }

  return {
    rebuiltRoutes: 1,
    routeIds: [routeId],
    removedChannels: removableChannels.length,
    createdChannels,
    updatedChannels,
  };
}

export async function rebuildAllPatternRouteChannels(
  options: RebuildPatternRouteOptions = {},
): Promise<PatternRouteChannelSyncResult> {
  const patternRoutes = (await db.select().from(schema.tokenRoutes).all())
    .filter((route: any) => route.enabled && isPatternGroupRoute(route));

  const result: PatternRouteChannelSyncResult = {
    rebuiltRoutes: 0,
    routeIds: [],
    removedChannels: 0,
    createdChannels: 0,
    updatedChannels: 0,
  };

  for (const route of patternRoutes) {
    const routeResult = await rebuildAutomaticRouteChannelsByModelPattern(route.id, route.modelPattern, options);
    result.rebuiltRoutes += 1;
    result.routeIds.push(route.id);
    result.removedChannels += routeResult.removedChannels;
    result.createdChannels += routeResult.createdChannels;
    result.updatedChannels += routeResult.updatedChannels;
  }

  if (result.removedChannels > 0 || result.createdChannels > 0 || result.updatedChannels > 0) {
    await clearRouteDecisionSnapshots(result.routeIds);
  }

  return result;
}

// Returns the candidate the system would derive for this channel right now, or
// null when the channel has no derivable default (e.g. it was added by hand or
// its account no longer offers a matching model). Used by the "restore to
// default" (reset) path so it can write the derived values back in place
// without touching the accumulated stats.
export async function findDerivedChannelCandidateForRoute(
  modelPattern: string,
  channel: {
    accountId: number;
    tokenId: number | null;
    oauthRouteUnitId: number | null;
    sourceModel: string | null;
  },
): Promise<PatternRouteChannelCandidate | null> {
  const pattern = (modelPattern || '').trim();
  if (!pattern) return null;

  const emptyExclusions = new Set<string>();
  // For exact routes the route's own channels must not re-echo their manual
  // edits back as "derived" values; only availability counts as the default.
  const isPattern = !isExactModelPattern(pattern);
  const exactRouteCandidates = isPattern
    ? (await getMatchedExactRouteChannelCandidates(pattern, emptyExclusions)).candidates
    : [];
  const availabilityExclusions = isPattern
    ? (await getMatchedExactRouteChannelCandidates(pattern, emptyExclusions)).exactModelNames
    : emptyExclusions;
  const availabilityCandidates = await getPatternTokenCandidates(pattern, availabilityExclusions);
  const candidates = dedupeRouteChannelCandidates([...exactRouteCandidates, ...availabilityCandidates]);
  if (candidates.length === 0) return null;

  const channelUnit = channel.oauthRouteUnitId ?? null;
  if (channelUnit !== null) {
    // Route-unit channels key on the unit; only the exact pair counts.
    return candidates.find((candidate) => buildChannelPairKey(candidate) === buildChannelPairKey(channel)) ?? null;
  }

  const sameAccountAndModel = (candidate: PatternRouteChannelCandidate) => (
    candidate.accountId === channel.accountId
    && normalizeModelKey(candidate.sourceModel || '') === normalizeModelKey(channel.sourceModel || '')
  );

  // Prefer the account's preferred (default) token carrying the same model —
  // that is what a fresh bind/reconcile would settle on. Fall back to the
  // current binding when it is still derivable, then to any candidate for the
  // account, so the channel is never left dangling.
  const preferredToken = await getPreferredAccountToken(channel.accountId);
  if (preferredToken) {
    const onPreferred = candidates.find((candidate) => (
      sameAccountAndModel(candidate) && candidate.tokenId === preferredToken.id
    ));
    if (onPreferred) return onPreferred;
  }

  const exactPair = candidates.find((candidate) => buildChannelPairKey(candidate) === buildChannelPairKey(channel));
  if (exactPair) return exactPair;
  return candidates.find(sameAccountAndModel)
    ?? candidates.find((candidate) => candidate.accountId === channel.accountId)
    ?? null;
}

export async function syncPatternRouteChannelsAfterAffectedRouteChanges(
  input: SyncPatternRouteChannelsAfterAffectedRouteChangesInput = {},
): Promise<PatternRouteChannelSyncResult> {
  const affectedRouteIds = normalizeAffectedRouteIds(input.affectedRouteIds);
  const removedExactModelPatterns = collectRemovedExactModelPatterns(input.removedRoutes);
  if (affectedRouteIds.length === 0 && removedExactModelPatterns.length === 0) {
    return createEmptyPatternRouteChannelSyncResult();
  }

  let hasAffectedExactSourceRoute = false;
  if (affectedRouteIds.length > 0) {
    const routes = await db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      routeMode: schema.tokenRoutes.routeMode,
    }).from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, affectedRouteIds))
      .all();

    hasAffectedExactSourceRoute = routes.some(isExactSourceRoute);
  }

  if (!hasAffectedExactSourceRoute && removedExactModelPatterns.length === 0) {
    return createEmptyPatternRouteChannelSyncResult();
  }

  return rebuildAllPatternRouteChannels({
    excludeExactModelPatterns: removedExactModelPatterns,
  });
}
