import { isPublicApiRoute } from './desktop.js';
import { REQUEST_BODY_UPLOAD_ROUTE_PREFIX } from './services/requestBodyChunkedUpload.js';

export type RouteScope = 'admin' | 'public' | 'upload' | 'other';

/**
 * Path portion of the request URL, percent-decoded, query dropped.
 *
 * `request.url` keeps the escapes the client sent (`/%61pi/sites`) while the
 * router decodes each segment before matching, so the raw string is NOT the path
 * the handler runs under — a gate keyed on it misses encoded admin paths
 * entirely. `decodeURI` decodes the unreserved set (`%61`, `%69`, `%2e`) and
 * leaves the reserved ones (`%2F`, `%3F`, `%23`) encoded, so an encoded slash
 * never becomes a separator here either — same outcome as find-my-way. A
 * malformed escape keeps the raw form: it cannot match a decoded admin route.
 */
export function resolveRequestUrlPath(rawUrl: string): string {
  const rawPath = (rawUrl || '').split('?')[0] || '/';
  try {
    return decodeURI(rawPath);
  } catch {
    return rawPath;
  }
}

/**
 * Which gate a request falls under. Both inputs matter because they disagree
 * under encoding: `matchedRouteUrl` is the pattern find-my-way actually matched
 * (authoritative), the decoded path is what the URL claims. A request counts as
 * a management API call when EITHER looks like `/api/...`, and the public /
 * self-authenticating exemptions only apply when BOTH agree — a path that is
 * public in one form and admin in the other is admin.
 */
export function resolveRequestRouteScope(
  rawUrl: string,
  matchedRouteUrl: string | undefined,
  deps: { isPublicApiRoute(rawUrl: string): boolean; uploadRoutePrefix: string },
): RouteScope {
  const path = resolveRequestUrlPath(rawUrl);
  const apiPaths = [matchedRouteUrl, path].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.startsWith('/api/'),
  );
  if (apiPaths.length === 0) return 'other';
  if (apiPaths.every((candidate) => deps.isPublicApiRoute(candidate))) return 'public';
  // The striped body-upload route authenticates itself (admin token, or the
  // downstream key the request it belongs to carries) and is deliberately
  // exempt: parts arrive with the caller's real credential, so gating them on
  // the admin token would reject every part and silently fall back to the
  // single-request upload.
  if (apiPaths.every((candidate) => candidate.startsWith(deps.uploadRoutePrefix))) return 'upload';
  return 'admin';
}

export const ROUTE_SCOPE_DEPENDENCIES = {
  isPublicApiRoute,
  uploadRoutePrefix: REQUEST_BODY_UPLOAD_ROUTE_PREFIX,
} as const;
