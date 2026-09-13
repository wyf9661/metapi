/**
 * SPA shell fallback policy for the static web bundle.
 *
 * A request that matched no route normally receives the SPA shell so client
 * routing can handle deep links. Asset-like paths (a non-empty final segment
 * containing a dot, e.g. /assets/index-abc.js) must NOT: the shell arrives as
 * 200 text/html and the browser rejects it with a MIME mismatch, hiding the
 * real cause (chunk deleted, stale cached shell pointing at an old build)
 * behind an opaque blank page. Returning 404 keeps the failure legible.
 */
export function isSpaShellFallbackCandidate(url: string): boolean {
  const path = stripQueryAndHash(url);
  const lastSlash = path.lastIndexOf('/');
  const lastSegment = path.slice(lastSlash + 1);
  if (lastSegment.length === 0) return true;
  return !lastSegment.includes('.');
}

function stripQueryAndHash(url: string): string {
  const source = typeof url === 'string' ? url : '';
  let end = source.length;
  const queryIndex = source.indexOf('?');
  if (queryIndex >= 0 && queryIndex < end) end = queryIndex;
  const hashIndex = source.indexOf('#');
  if (hashIndex >= 0 && hashIndex < end) end = hashIndex;
  return source.slice(0, end);
}
