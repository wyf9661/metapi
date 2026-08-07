/**
 * Shared string-trimming helper. Extracted from ~45 duplicate local
 * definitions across the server codebase (all identical implementations).
 *
 * Note: 7 files (oauth/*, accountTokens) use a DIFFERENT semantic —
 * `trimmed || undefined` (empty string collapses to undefined). Those keep
 * their local definitions intentionally; do not merge them here.
 */
export function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
