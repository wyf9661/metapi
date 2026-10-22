function normalizeBaseModelName(modelName: string): string {
  let value = String(modelName || '').trim().toLowerCase();
  if (!value) return '';

  // Provider prefixes vary across relays (e.g. z-ai/glm-5.2 vs glm-5.2) and
  // aggregators put their own provider alias in front of the upstream id
  // (9router: caic/linux6200/bge-reranker-v2-m3:latest), so only the last
  // '/'-segment carries the model identity and every segment before it is
  // packaging noise. A trailing ':tag' pins a real variant (qwen2.5:3b,
  // gpt-5:batch) and stays attached to that last segment — it never turns the
  // prefix into part of the name.
  const slashParts = value.split('/').map((part) => part.trim()).filter(Boolean);
  if (slashParts.length > 1) value = slashParts[slashParts.length - 1]!;

  // ollama's ':latest' is the default tag: name:latest and name are the same
  // artifact, and clients never request the suffix.
  value = value.replace(/:latest$/i, '');

  // Free suffixes are packaging labels, not model capability differences.
  value = value.replace(/:free$/i, '');
  value = value.replace(/-free$/i, '');

  return value.trim();
}

export function canonicalizeModelName(modelName: string): string {
  const value = normalizeBaseModelName(modelName);
  if (!value) return '';

  return stripPackagingLabels(value) || value;
}

// Free labels are packaging noise, not model capability differences,
// including the channel-ordinal forms some relays append (…-free-3).
const FREE_LABEL_RE = /-(?:free(?:-\d+)?|:free)$/i;

// A maximal run of dash-separated digit-only segments that spells a calendar
// date is part of the official model identity and stays intact:
// gpt-4o-2024-05-13 (YYYY-MM-DD) and command-r-08-2024 (MM-YYYY) keep every
// segment. A LONE digit segment of 4/6/8 length is a snapshot label instead —
// deepseek-v4-flash-0731 (MMDD), -260731 (YYMMDD), -20260731 (YYYYMMDD) —
// packaging noise wherever it sits in the name.
const CALENDAR_DATE_RUN_RE = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{4}-\d{1,2}|\d{1,2}-\d{4})$/;
const SNAPSHOT_SEGMENT_RE = /^\d{4}$|^\d{6}$|^\d{8}$/;
// Context-window labels are the same class of noise: channels claiming a
// window are not guaranteed to serve it and clients never request the suffix.
const CONTEXT_WINDOW_SEGMENT_RE = /^(?:1m|262k)$/i;
const DIGIT_SEGMENT_RE = /^\d+$/;

/**
 * Drops snapshot/context-window segments from anywhere in the name in one
 * pass. Digit runs that spell a calendar date are skipped as a whole, and a
 * strip that would erase the entire name (a bare "20260731") is refused.
 */
function stripDecorationSegments(name: string): string {
  const segments = name.split('-');
  const drop = segments.map(() => false);
  let index = 0;
  while (index < segments.length) {
    const segment = segments[index]!;
    if (!DIGIT_SEGMENT_RE.test(segment)) {
      if (CONTEXT_WINDOW_SEGMENT_RE.test(segment)) drop[index] = true;
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < segments.length && DIGIT_SEGMENT_RE.test(segments[end + 1]!)) {
      end += 1;
    }
    const run = segments.slice(index, end + 1).join('-');
    if (!CALENDAR_DATE_RUN_RE.test(run)) {
      for (let cursor = index; cursor <= end; cursor += 1) {
        if (SNAPSHOT_SEGMENT_RE.test(segments[cursor]!)) drop[cursor] = true;
      }
    }
    index = end + 1;
  }
  if (!drop.some(Boolean)) return name;
  const rebuilt = segments.filter((_, position) => !drop[position]).join('-');
  return rebuilt.trim() ? rebuilt : name;
}

/**
 * Normalization is condition-based for EVERY family, never an enumerated
 * list: the 0731 / 0813 / 1017 deepseek snapshots each needed their own
 * whitelist entry before this. Free labels and date snapshots stack
 * (deepseek-v4-flash-0731-free-3, deepseek-v4.1-flash-1017-think), so peel
 * one layer at a time until the name stops changing.
 */
function stripPackagingLabels(name: string): string {
  let current = name;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const freeStripped = current.replace(FREE_LABEL_RE, '');
    let next = freeStripped !== current ? freeStripped : current;
    if (next === current) {
      const decorationStripped = stripDecorationSegments(current);
      if (decorationStripped !== current) next = decorationStripped;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}
