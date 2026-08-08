/**
 * Pure helpers extracted from stats.ts (routes/api).
 *
 * These are deterministic input→output functions with NO dependency on
 * module-level state, DB, or the Fastify handler scope. Keeping them here
 * makes the route file smaller and lets the normalization logic be unit
 * tested / reused without booting a server.
 */

export function parseBooleanFlag(raw?: string): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function normalizeDashboardView(raw?: string) {
  const normalized = (raw || "").trim().toLowerCase();
  if (normalized === "summary" || normalized === "insights") {
    return normalized;
  }
  return "full";
}

export function normalizeProxyLogsView(raw?: string) {
  const normalized = (raw || "").trim().toLowerCase();
  if (normalized === "query" || normalized === "meta") {
    return normalized;
  }
  return "full";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeProxyLogPageSize(raw?: string): number {
  const parsed = Number.parseInt(raw || "50", 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(100, parsed));
}

export function normalizeProxyLogOffset(raw?: string): number {
  const parsed = Number.parseInt(raw || "0", 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

export function normalizeProxyLogSearch(raw?: string): string {
  return (raw || "").trim().toLowerCase();
}

export function normalizeProxyLogSiteId(raw?: string): number | null {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function parseDownstreamKeyTags(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of parsed) {
      const text = String(value || "").trim();
      if (!text) continue;
      const dedupeKey = text.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      result.push(text);
    }
    return result;
  } catch {
    return [];
  }
}

export function toRoundedMicroNumber(value: number | null | undefined): number {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

export function normalizeNullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeClientConfidence(value: unknown): string | null {
  const normalized = normalizeNullableText(value)?.toLowerCase() || null;
  if (
    normalized === "exact" ||
    normalized === "heuristic" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return null;
}

export function roundPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}
