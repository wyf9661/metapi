function normalizeBaseModelName(modelName: string): string {
  let value = String(modelName || '').trim().toLowerCase();
  if (!value) return '';

  // Provider prefixes vary across relays (e.g. z-ai/glm-5.2 vs glm-5.2), so a
  // bare prefix is stripped. A trailing ':tag' however marks an ollama-style
  // namespace (owner/model:tag, e.g. linux6200/bge-reranker-v2-m3:latest)
  // where the owner is part of the model identity: different owners are
  // different artifacts and must NOT be merged by dropping the prefix. Free
  // labels are packaging noise, so they are ignored when deciding whether the
  // segment carries a real tag (z-ai/glm-5.2:free still merges to glm-5.2).
  const slashParts = value.split('/').map((part) => part.trim()).filter(Boolean);
  if (slashParts.length > 1) {
    const last = slashParts[slashParts.length - 1]!;
    const tagFreeLast = last.replace(/:free$/i, '').replace(/-free$/i, '');
    if (!tagFreeLast.includes(':')) value = last;
  }

  // Free suffixes are packaging labels, not model capability differences.
  value = value.replace(/:free$/i, '');
  value = value.replace(/-free$/i, '');

  return value.trim();
}

export function canonicalizeModelName(modelName: string): string {
  const value = normalizeBaseModelName(modelName);
  if (!value) return '';

  return stripKnownFamilyDecorations(value) || value;
}

// Real model families whose date-snapshot / free-label aliases may be merged.
// True capability variants (think/fast/highspeed/fast-preview) are kept
// intact; context-window decorations (1m/262k) are treated as unreliable
// packaging labels — channels claiming them are not guaranteed to serve the
// full window and clients never request them (2026-09-09 analysis), so they
// are stripped wherever they appear inside a family name.
const KNOWN_FAMILY_BASE = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'glm-5\\.2',
  'glm-5\\.3',
  'minimax-m2\\.1',
  'minimax-m2\\.5',
  'minimax-m2\\.7',
  'minimax-m3',
].join('|');
const KNOWN_FAMILY_ACTION_VARIANTS =
  '(?:-(?:fast|think|fast-think|highspeed|fast-preview))*';
const KNOWN_FAMILY_RE = new RegExp(`^(${KNOWN_FAMILY_BASE})${KNOWN_FAMILY_ACTION_VARIANTS}$`);
const FAMILY_PREFIX_RE = new RegExp(`^(${KNOWN_FAMILY_BASE})(?=-|$)`);

const FREE_LABEL_RE = /-(?:free(?:-\d+)?|:free)$/i;
// Decorations that may sit at the tail (deepseek-v4-flash-0731, glm-5.3-1M)
// or between the base and a kept variant (deepseek-v4-flash-0731-think,
// glm-5.2-1m-think): date snapshots and context-window labels. Stripped
// segment-wise inside a family name.
const DECORATION_SEGMENT_RE = /-(?:\d{4}|\d{6}|\d{8}|1m|262k)(?=-|$)/gi;

/**
 * Strips stacked decorations from a known-family model name, one layer at a
 * time, until the remainder is a clean family name (true action variants
 * intact). Handles compound aliases such as deepseek-v4-flash-0731-free-3
 * (date snapshot + free channel ordinal), deepseek-v4-pro-0813-think (date
 * snapshot before a think variant) and glm-5.2-1m-think (context-window
 * label between the base and a think variant) — a single anchored replace
 * never matched these because each layer hides the previous one's anchor.
 * Names of other families (claude/gpt/grok date snapshots) never match
 * KNOWN_FAMILY_RE after stripping, so they fall through untouched.
 */
function stripKnownFamilyDecorations(name: string): string | null {
  let current = name;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (KNOWN_FAMILY_RE.test(current)) return current;

    const freeStripped = current.replace(FREE_LABEL_RE, '');
    let next = freeStripped !== current ? freeStripped : current;

    // Segment-level stripping only inside a family name, so other families'
    // date-bearing names (gpt-4o-2024-05-13, grok-4.20-0309-*) never lose
    // their segments.
    if (next === current && FAMILY_PREFIX_RE.test(current)) {
      const segmentStripped = current.replace(DECORATION_SEGMENT_RE, '');
      if (segmentStripped !== current) next = segmentStripped;
    }

    if (next === current) return null;
    current = next;
  }
  return null;
}
