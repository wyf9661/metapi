function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || '').replace(/\/+$/, '');
}

function baseIncludesVersion(baseUrl: string): boolean {
  return /\/v\d+(?:beta)?(?:\/|$)/i.test(baseUrl);
}

export function resolveGeminiNativeBaseUrl(baseUrl: string, apiVersion: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (baseIncludesVersion(normalized)) return normalized;
  return `${normalized}/${apiVersion}`;
}

export function resolveGeminiModelsUrl(
  baseUrl: string,
  apiVersion: string,
  apiKey: string,
): string {
  const base = resolveGeminiNativeBaseUrl(baseUrl, apiVersion);
  const separator = base.includes('?') ? '&' : '?';
  return `${base}/models${separator}key=${encodeURIComponent(apiKey)}`;
}

export function resolveGeminiGenerateContentUrl(
  baseUrl: string,
  apiVersion: string,
  modelActionPath: string,
  apiKey: string,
  search: string,
): string {
  const base = resolveGeminiNativeBaseUrl(baseUrl, apiVersion);
  const normalizedAction = modelActionPath.replace(/^\/+/, '');
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.set('key', apiKey);
  const query = params.toString();
  return `${base}/${normalizedAction}${query ? `?${query}` : ''}`;
}
