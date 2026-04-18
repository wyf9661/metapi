function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function shouldStripCompactResponsesStore(sitePlatform?: string): boolean {
  const normalized = asTrimmedString(sitePlatform).toLowerCase();
  return normalized === 'codex' || normalized === 'sub2api';
}

function shouldForceCompactResponsesJsonAccept(sitePlatform?: string): boolean {
  return shouldStripCompactResponsesStore(sitePlatform);
}

export function shouldForceResponsesUpstreamStream(input: {
  sitePlatform?: string;
  isCompactRequest?: boolean;
}): boolean {
  if (input.isCompactRequest) return false;
  const sitePlatform = asTrimmedString(input.sitePlatform).toLowerCase();
  return sitePlatform === 'codex' || sitePlatform === 'sub2api';
}

export function sanitizeCompactResponsesRequestBody(
  body: Record<string, unknown>,
  options?: {
    sitePlatform?: string;
  },
): Record<string, unknown> {
  const next = { ...body };
  delete next.stream;
  delete next.stream_options;
  if (shouldStripCompactResponsesStore(options?.sitePlatform)) {
    delete next.store;
  }
  return next;
}

export function ensureCompactResponsesJsonAcceptHeader(
  headers: Record<string, string>,
  options?: {
    sitePlatform?: string;
  },
): Record<string, string> {
  if (!shouldForceCompactResponsesJsonAccept(options?.sitePlatform)) return headers;
  const nextHeaders = { ...headers };
  delete (nextHeaders as Record<string, unknown>).Accept;
  delete (nextHeaders as Record<string, unknown>).accept;
  return {
    ...nextHeaders,
    accept: 'application/json',
  };
}

export function shouldFallbackCompactResponsesToResponses(input: {
  status?: number;
  rawErrText?: string;
  requestPath?: string;
}): boolean {
  const status = Number.isFinite(Number(input.status)) ? Number(input.status) : 0;
  const compact = asTrimmedString(input.rawErrText).toLowerCase();
  const requestPath = asTrimmedString(input.requestPath).toLowerCase();
  const hasRawCompactHint = (
    compact.includes('/responses/compact')
    || compact.includes('responses/compact')
    || compact.includes('compact endpoint')
    || /(^|[^a-z])compact([^a-z]|$)/.test(compact)
  );
  const hasCompactRequestPathHint = (
    requestPath.endsWith('/responses/compact')
    || requestPath.endsWith('/v1/responses/compact')
  );
  const isInvalidCompactUrl = compact.includes('invalid url') && hasRawCompactHint;

  if (status === 404 || status === 405 || status === 501) return true;

  return (
    (compact.includes("unknown parameter: 'stream'") && (hasRawCompactHint || hasCompactRequestPathHint))
    || isInvalidCompactUrl
    || (
      hasRawCompactHint
      && (
        compact.includes('not supported')
        || compact.includes('unsupported')
      )
    )
  );
}
