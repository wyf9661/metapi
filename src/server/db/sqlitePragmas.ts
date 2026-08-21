/**
 * Runtime PRAGMA tuning for the SQLite connection.
 *
 * Kept in one place (instead of inline in `initSqliteDb`) so the exact tuning
 * story is testable and reviewable.
 *
 * Correctness-preserving choices:
 * - `journal_mode = WAL` — concurrent readers alongside a writer.
 * - `foreign_keys = ON` — enforce declared relations.
 * - `busy_timeout` — wait instead of failing instantly under write contention.
 * - `synchronous = NORMAL` — the standard companion to WAL. Durable across
 *   process crashes; only an OS/host crash can lose the last transactions,
 *   which is the accepted trade for a local gateway log store.
 * - `cache_size` (negative = KiB) and `mmap_size` — read-path headroom for the
 *   large `proxy_logs` table.
 * - `temp_store = MEMORY` — keeps sort/group temporaries off disk; the stats
 *   endpoints group and order over log ranges.
 */

export type SqlitePragmaConnection = {
  pragma(source: string): unknown;
};

export const SQLITE_CACHE_SIZE_KIB = 16_384;
export const SQLITE_MMAP_SIZE_BYTES = 268_435_456;

export function applySqliteRuntimePragmas(
  connection: SqlitePragmaConnection,
  options: { busyTimeoutMs?: number } = {},
): string[] {
  const busyTimeoutMs = Number.isFinite(options.busyTimeoutMs)
    ? Math.max(0, Math.trunc(Number(options.busyTimeoutMs)))
    : 5000;

  const statements = [
    'journal_mode = WAL',
    'foreign_keys = ON',
    `busy_timeout = ${busyTimeoutMs}`,
    'synchronous = NORMAL',
    // Negative values are interpreted by SQLite as KiB rather than pages.
    `cache_size = -${SQLITE_CACHE_SIZE_KIB}`,
    `mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`,
    'temp_store = MEMORY',
  ];

  const applied: string[] = [];
  for (const statement of statements) {
    try {
      connection.pragma(statement);
      applied.push(statement);
    } catch (error) {
      // A pragma being unavailable (e.g. mmap disabled in a build) must never
      // stop startup — the database still works, just without that tuning.
      console.warn(`[db] pragma failed: ${statement}`, error);
    }
  }
  return applied;
}

/**
 * Ask SQLite to refresh its query-planner statistics.
 *
 * `PRAGMA optimize` is the documented cheap form of ANALYZE: it only does work
 * when the planner's stats are actually stale, so it is safe to call after bulk
 * deletes (log retention) and at startup.
 */
export function optimizeSqlite(connection: SqlitePragmaConnection): boolean {
  try {
    connection.pragma('optimize');
    return true;
  } catch (error) {
    console.warn('[db] pragma optimize failed', error);
    return false;
  }
}
