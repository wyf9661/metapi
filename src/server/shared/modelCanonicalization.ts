function normalizeBaseModelName(modelName: string): string {
  let value = String(modelName || '').trim().toLowerCase();
  if (!value) return '';

  // Provider prefixes vary across relays (e.g. z-ai/glm-5.2 vs glm-5.2).
  const slashParts = value.split('/').map((part) => part.trim()).filter(Boolean);
  if (slashParts.length > 1) value = slashParts[slashParts.length - 1]!;

  // Free suffixes are packaging labels, not model capability differences.
  value = value.replace(/:free$/i, '');
  value = value.replace(/-free$/i, '');

  return value.trim();
}

export function canonicalizeModelName(modelName: string): string {
  const value = normalizeBaseModelName(modelName);
  if (!value) return '';

  // Explicit allowlist: keep true variants (think/fast/1m/262k/etc.) intact,
  // but merge case, provider-prefix and free-label aliases for known families.
  if (/^minimax-m2\.7$/.test(value)) return 'minimax-m2.7';
  if (/^glm-5\.2(?:-(?:1m|262k|think|1m-think|262k-think))?$/.test(value)) return value;
  if (/^deepseek-v4-flash(?:-(?:fast|think|fast-think))?$/.test(value)) return value;

  // Date-suffix snapshots (deepseek-v4-flash-0731 / -20260731) are alias
  // labels of the same base model. Only strip them for known families so
  // official snapshot names (e.g. claude-sonnet-4-5-20250929) stay intact.
  const stripped = value.replace(/-(?:\d{4}|\d{6}|\d{8})$/i, '');
  if (stripped !== value) {
    if (/^deepseek-v4-flash(?:-(?:fast|think|fast-think))?$/.test(stripped)) {
      return stripped;
    }
    if (/^glm-5\.2(?:-(?:1m|262k|think|1m-think|262k-think))?$/.test(stripped)) {
      return stripped;
    }
  }

  return value;
}
