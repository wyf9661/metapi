/**
 * Shared pagination param normalization for list endpoints.
 *
 * Guards against the two failure modes that used to 500 / blow up:
 * - NaN from parseInt("abc") → better-sqlite3 throws "datatype mismatch"
 * - negative / huge limits → full-table scans (LIMIT -1 = unlimited)
 */

export function normalizePageSize(
  raw: unknown,
  fallback = 50,
  max = 200,
): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function normalizePageOffset(raw: unknown, fallback = 0): number {
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
