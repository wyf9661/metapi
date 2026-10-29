/**
 * The one deep clone for JSON-shaped payloads.
 *
 * This lived as ~19 private copies named cloneJson/cloneJsonValue/cloneJsonObject across
 * transformers, services and routes. They were byte-identical, so a fix to any of them (or a
 * prototype-pollution guard added to one) silently skipped the rest. Values here are always
 * parsed JSON: plain objects, arrays, strings, numbers, booleans, null.
 */
export function cloneJsonDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonDeep(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, cloneJsonDeep(item)]),
    ) as T;
  }
  return value;
}
