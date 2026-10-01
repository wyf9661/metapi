/**
 * Shared token-mask helpers — the single source of truth for comparing token
 * values where one or both sides may be masked by the upstream site.
 *
 * Two callers depend on this:
 *   - accountTokenService: rebinding an upstream (often masked) key to the
 *     local plaintext row during sync.
 *   - platform adapters: proving which upstream token a local key refers to
 *     (to revoke it) or that it is genuinely absent.
 *
 * Rules:
 *   - the `sk-` prefix is normalised on both sides before comparing;
 *   - `*` and `•` both count as mask characters;
 *   - a masked value only proves identity through its visible prefix/suffix,
 *     and only when enough characters stay visible (see MIN_VISIBLE_CHARS) —
 *     a 1-character overlap would match unrelated keys and, on the delete
 *     path, could revoke the wrong upstream token.
 */

/** Masked values must keep at least this many visible characters (excluding `sk-`). */
export const MIN_VISIBLE_CHARS = 8;

export type TokenValueRelation = 'match' | 'mismatch' | 'unknown';

/** Normalise a token for display: ensure it carries the `sk-` prefix. */
export function normalizeTokenForDisplay(token?: string | null): string {
  if (!token) return '';
  const value = token.trim();
  if (!value) return '';
  if (value.toLowerCase().startsWith('sk-')) return value;
  return `sk-${value}`;
}

/** Does the value contain mask characters? */
export function isMaskedTokenValue(token: string | null | undefined): boolean {
  const value = (token || '').trim();
  if (!value) return false;
  return value.includes('*') || value.includes('•');
}

interface MaskShape {
  /** Visible characters before the mask, or null when nothing is visible there. */
  prefix: string | null;
  /** Visible characters after the mask, or null when nothing is visible there. */
  suffix: string | null;
  /** Visible characters on both sides, `sk-` excluded. */
  visibleChars: number;
}

/** Extract the visible shape of a masked value; null when the mask is opaque. */
function readMaskShape(maskedValue: string): MaskShape | null {
  const value = normalizeTokenForDisplay(maskedValue);
  const firstMask = value.search(/[\*•]/);
  if (firstMask < 0) return null;

  const lastMask = Math.max(value.lastIndexOf('*'), value.lastIndexOf('•'));
  const prefix = value.slice(0, firstMask);
  const suffix = value.slice(lastMask + 1);

  const prefixBody = prefix.replace(/^sk-/i, '');
  const visibleChars = prefixBody.length + suffix.length;
  if (visibleChars === 0) return null;

  return {
    prefix: prefixBody.length > 0 ? prefix : null,
    suffix: suffix.length > 0 ? suffix : null,
    visibleChars,
  };
}

/** Is one string a prefix of the other (either direction)? */
function prefixCompatible(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/** Is one string a suffix of the other (either direction)? */
function suffixCompatible(a: string, b: string): boolean {
  return a.endsWith(b) || b.endsWith(a);
}

/**
 * Compare two token values where either or both may be masked.
 *
 * - `match`    — consistent with being the same underlying key.
 * - `mismatch` — definitely different keys.
 * - `unknown`  — not enough visible information to decide (fail closed).
 */
export function classifyTokenValue(
  left: string | null | undefined,
  right: string | null | undefined,
): TokenValueRelation {
  const a = normalizeTokenForDisplay(left);
  const b = normalizeTokenForDisplay(right);
  if (!a || !b) return 'unknown';

  const aMasked = isMaskedTokenValue(a);
  const bMasked = isMaskedTokenValue(b);
  if (!aMasked && !bMasked) return a === b ? 'match' : 'mismatch';

  const aShape = aMasked ? readMaskShape(a) : null;
  const bShape = bMasked ? readMaskShape(b) : null;
  if ((aMasked && !aShape) || (bMasked && !bShape)) return 'unknown';

  // Enough visible characters to pin the key down?  Only masked sides count:
  // a plaintext side is fully visible by definition, while a short mask (e.g.
  // `sk-abc***xyz`) cannot be trusted in either direction — a few visible
  // characters would match unrelated keys and, on the delete path, could
  // revoke the wrong upstream token.  Check this BEFORE any prefix/suffix
  // reasoning: a short mask is uninterpretable, not evidence.
  const maskedShapes = [aShape, bShape].filter((shape): shape is MaskShape => shape !== null);
  if (maskedShapes.some((shape) => shape.visibleChars < MIN_VISIBLE_CHARS)) return 'unknown';

  // A plaintext side acts as its own visible prefix and suffix.
  const aPrefix = aShape ? aShape.prefix : a;
  const bPrefix = bShape ? bShape.prefix : b;
  const aSuffix = aShape ? aShape.suffix : a;
  const bSuffix = bShape ? bShape.suffix : b;

  if (aPrefix && bPrefix && !prefixCompatible(aPrefix, bPrefix)) return 'mismatch';
  if (aSuffix && bSuffix && !suffixCompatible(aSuffix, bSuffix)) return 'mismatch';

  return 'match';
}

/** True only when the two values are confidently the same key. */
export function maskMatches(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return classifyTokenValue(left, right) === 'match';
}

/** True when a masked value is informative enough to rule keys in or out. */
export function isClassifiableTokenKey(key: string | null | undefined): boolean {
  const value = normalizeTokenForDisplay(key);
  if (!value) return false;
  if (!isMaskedTokenValue(value)) return true;
  const shape = readMaskShape(value);
  return shape !== null && shape.visibleChars >= MIN_VISIBLE_CHARS;
}

/**
 * Locate the local key inside a list of upstream keys.
 *
 * - `{ index }`    — exactly one upstream key matches.
 * - `{ index: null, absent: true }` — no key matches and every key was
 *   classifiable, so the token is provably gone upstream.
 * - `{ index: null, absent: false }` — ambiguous; callers must fail closed.
 */
export function locateTokenInKeys(
  localToken: string | null | undefined,
  upstreamKeys: Array<string | null | undefined>,
): { index: number | null; absent: boolean; present: boolean } {
  const matches: number[] = [];
  let allClassifiable = true;

  upstreamKeys.forEach((key, index) => {
    const relation = classifyTokenValue(localToken, key);
    if (relation === 'match') matches.push(index);
    else if (relation === 'unknown') allClassifiable = false;
  });

  if (matches.length === 1) return { index: matches[0], absent: false, present: true };
  // Two upstream rows matching one key means the mask is ambiguous — never
  // guess, or the delete path could revoke the wrong token.
  if (matches.length > 1) return { index: null, absent: false, present: false };
  return { index: null, absent: allClassifiable, present: false };
}
