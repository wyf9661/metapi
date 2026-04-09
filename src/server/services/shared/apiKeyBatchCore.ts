export function parseBatchApiKeys(input: unknown): string[] {
  if (Array.isArray(input)) {
    return Array.from(new Set(
      input
        .map((item) => String(item || '').trim())
        .filter((item) => item.length > 0),
    ));
  }

  const raw = String(input || '').trim();
  if (!raw) return [];

  return Array.from(new Set(
    raw
      .split(/[\r\n,，;；\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  ));
}

export function buildBatchApiKeyConnectionName(baseName: string | null | undefined, index: number, total: number): string {
  const normalized = String(baseName || '').trim();
  if (!normalized) return '';
  if (total <= 1) return normalized;
  return `${normalized} #${index + 1}`;
}
