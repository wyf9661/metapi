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
