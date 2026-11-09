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
 * Which gate a request falls under, keyed on the route find-my-way actually
 * matched — that pattern is what runs, so it cannot be dodged by encoding the
 * URL. `routeOptions.url` is unset only when nothing matched at all; fall back
 * to the decoded path there and gate it (fail closed).
 *
 * A path that merely LOOKS like `/api/...` but matched no management route (the
 * SPA wildcard catches scanners probing `/api/show`) stays 'other': those stay
 * 404s instead of auth failures. That matters because every tunneled request
 * shares one client address (TRUST_PROXY is off), so unauthenticated probes on
 * paths with no handler would spend the whole tunnel's auth failure budget and
 * lock the console out.
 */
export function resolveRequestRouteScope(
  rawUrl: string,
  matchedRouteUrl: string | undefined,
  deps: { isPublicApiRoute(rawUrl: string): boolean; uploadRoutePrefix: string },
): RouteScope {
  const routePath = matchedRouteUrl || resolveRequestUrlPath(rawUrl);
  if (!routePath.startsWith('/api/')) return 'other';
  if (deps.isPublicApiRoute(routePath)) return 'public';
  // The striped body-upload route authenticates itself (admin token, or the
  // downstream key the request it belongs to carries) and is deliberately
  // exempt: parts arrive with the caller's real credential, so gating them on
  // the admin token would reject every part and silently fall back to the
  // single-request upload.
  if (routePath.startsWith(deps.uploadRoutePrefix)) return 'upload';
  return 'admin';
}

export const ROUTE_SCOPE_DEPENDENCIES = {
  isPublicApiRoute,
  uploadRoutePrefix: REQUEST_BODY_UPLOAD_ROUTE_PREFIX,
} as const;
