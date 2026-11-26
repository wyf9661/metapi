/**
 * Upstream platforms where NewAPI-class Codex gateways validate client
 * identity: they reject non-Codex clients at the edge (401 "unauthorized
 * client detected") unless the request carries a Codex CLI fingerprint.
 * The fingerprint is stamped automatically (face-driven identity), never
 * through a user-facing site switch.
 */
export const CODEX_GATED_PLATFORMS = new Set([
  'new-api',
  'one-api',
  'sub2api',
  'openai',
]);

export function isCodexGatedPlatform(platform: unknown): boolean {
  if (typeof platform !== 'string') return false;
  return CODEX_GATED_PLATFORMS.has(platform.trim().toLowerCase());
}

/**
 * NewAPI-class relays whose groups can additionally gate on the request body
 * ("This group only allows Codex clients"). Measured on a live relay: a new
 * Codex version header, x-codex-* identifiers, include and store each still
 * got 403; only a body-level prompt_cache_key passed. Official OpenAI is not
 * in this set — its traffic must stay byte-identical to what it was.
 */
const CODEX_GROUP_GATED_PLATFORMS = new Set([
  'new-api',
  'one-api',
  'sub2api',
]);

export function isCodexGroupGatedPlatform(platform: unknown): boolean {
  if (typeof platform !== 'string') return false;
  return CODEX_GROUP_GATED_PLATFORMS.has(platform.trim().toLowerCase());
}
