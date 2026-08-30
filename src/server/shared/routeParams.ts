/**
 * Route param helpers shared across API route files.
 *
 * `parsePositiveIntParam` exists because route handlers historically used
 * bare `parseInt(request.params.id)` and only some of them validated the
 * result. NaN or non-positive ids would then flow into SQLite `eq()`
 * queries, which silently match nothing but behave inconsistently across
 * routes. Use this helper everywhere a path param must be a positive
 * integer and return 400 when it returns null.
 */

export function parsePositiveIntParam(
  value: string | undefined,
): number | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  // Path params must be a pure digit string — `Number.parseInt` would
  // silently accept trailing garbage like '12abc', which is not a valid id.
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}
