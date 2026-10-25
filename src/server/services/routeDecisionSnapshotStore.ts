import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

/**
 * Cap on the candidates persisted per route decision snapshot.
 *
 * A wildcard route scores every channel it owns, and each candidate carries a
 * full factor breakdown. On a large pool that produced a 306 KB row for a
 * single route — 38% of all snapshot bytes in the database — and the whole
 * payload was shipped to the dashboard on every route-list request.
 *
 * The panel renders the selected reason and the per-channel states it can
 * match; candidates past the cap degrade to "实时决策" on the client, which is
 * exactly what an unscored channel shows. The selected candidate is always
 * retained, so the reason for the channel that actually served is never lost.
 */
export const MAX_SNAPSHOT_CANDIDATES = 30;

type SnapshotWithCandidates = {
  candidates?: unknown[];
  selectedChannelId?: unknown;
  [key: string]: unknown;
};

function truncateCandidates(snapshot: SnapshotWithCandidates): SnapshotWithCandidates {
  const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : null;
  if (!candidates || candidates.length <= MAX_SNAPSHOT_CANDIDATES) return snapshot;

  const kept = candidates.slice(0, MAX_SNAPSHOT_CANDIDATES);
  const selectedChannelId = snapshot.selectedChannelId;
  if (typeof selectedChannelId === 'number') {
    const keptIds = new Set(kept.map((candidate) => (candidate as { channelId?: unknown })?.channelId));
    if (!keptIds.has(selectedChannelId)) {
      const selected = candidates.find(
        (candidate) => (candidate as { channelId?: unknown })?.channelId === selectedChannelId,
      );
      // Swap the weakest kept slot rather than appending, so the cap holds.
      if (selected) kept[kept.length - 1] = selected;
    }
  }

  return {
    ...snapshot,
    candidates: kept,
    candidateTotal: candidates.length,
    candidatesTruncated: true,
  };
}

function serializeSnapshot(snapshot: unknown): string | null {
  if (snapshot == null) return null;
  const value = typeof snapshot === 'object' && snapshot !== null
    ? truncateCandidates(snapshot as SnapshotWithCandidates)
    : snapshot;
  return JSON.stringify(value);
}

export function parseRouteDecisionSnapshot(value: unknown): unknown | null {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function saveRouteDecisionSnapshot(routeId: number, snapshot: unknown): Promise<void> {
  await saveRouteDecisionSnapshots([{ routeId, snapshot }]);
}

/**
 * Persist snapshots in one transaction.
 *
 * The refresh workflow writes one row per route (288 on a live install). Doing
 * that as independent statements meant one commit — and one fsync — each; the
 * batch pays that once and also keeps the refresh atomic from a reader's view.
 */
export async function saveRouteDecisionSnapshots(entries: Array<{ routeId: number; snapshot: unknown }>): Promise<void> {
  if (entries.length === 0) return;
  const refreshedAt = formatUtcSqlDateTime(new Date());
  await db.transaction(async (tx: any) => {
    for (const entry of entries) {
      await tx.update(schema.tokenRoutes)
        .set({
          decisionSnapshot: serializeSnapshot(entry.snapshot),
          decisionRefreshedAt: refreshedAt,
        })
        .where(eq(schema.tokenRoutes.id, entry.routeId))
        .run();
    }
  });
}

export async function clearRouteDecisionSnapshot(routeId: number): Promise<void> {
  await clearRouteDecisionSnapshots([routeId]);
}

export async function clearRouteDecisionSnapshots(routeIds: number[]): Promise<void> {
  const normalizedRouteIds = Array.from(new Set(
    routeIds
      .map((routeId) => Math.trunc(routeId))
      .filter((routeId) => routeId > 0),
  ));
  if (normalizedRouteIds.length === 0) return;

  await db.update(schema.tokenRoutes)
    .set({
      decisionSnapshot: null,
      decisionRefreshedAt: null,
    })
    .where(inArray(schema.tokenRoutes.id, normalizedRouteIds))
    .run();
}

export async function clearAllRouteDecisionSnapshots(): Promise<void> {
  await db.update(schema.tokenRoutes)
    .set({
      decisionSnapshot: null,
      decisionRefreshedAt: null,
    })
    .run();
}
