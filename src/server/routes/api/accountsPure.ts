import type { schema } from '../../db/index.js';
import {
  getCredentialModeFromExtraConfig,
  normalizeCredentialMode as normalizeCredentialModeInput,
  type AccountCredentialMode,
} from '../../services/accountExtraConfig.js';
import { parseBatchApiKeys } from '../../services/apiKeyBatch.js';
import type { AccountCreatePayload } from '../../contracts/accountsRoutePayloads.js';

/**
 * Pure account-route helpers: normalization, credential-mode capability
 * derivation and upstream error classification. No db, no network, no
 * request-scoped state — extracted from accounts.ts so the route module
 * keeps the HTTP orchestration only.
 */

export type AccountCapabilities = {
  canCheckin: boolean;
  canRefreshBalance: boolean;
  proxyOnly: boolean;
};

export type VerifyFailureReason =
  | 'needs-user-id'
  | 'invalid-user-id'
  | 'shield-blocked'
  | null;


export function parseBooleanFlag(raw?: string): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function hasSessionTokenValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function resolveRequestedCredentialMode(input: unknown): AccountCredentialMode {
  return normalizeCredentialModeInput(input) || 'auto';
}

export function resolveStoredCredentialMode(
  account: typeof schema.accounts.$inferSelect,
): AccountCredentialMode {
  const fromConfig = getCredentialModeFromExtraConfig(account.extraConfig);
  if (fromConfig && fromConfig !== 'auto') return fromConfig;
  return hasSessionTokenValue(account.accessToken) ? 'session' : 'apikey';
}

export function buildCapabilitiesFromCredentialMode(
  credentialMode: AccountCredentialMode,
  hasSessionToken: boolean,
): AccountCapabilities {
  const sessionCapable =
    credentialMode === 'session'
      ? hasSessionToken
      : credentialMode === 'apikey'
        ? false
        : hasSessionToken;
  return {
    canCheckin: sessionCapable,
    canRefreshBalance: sessionCapable,
    proxyOnly: !sessionCapable,
  };
}

export function buildCapabilitiesForAccount(
  account: typeof schema.accounts.$inferSelect,
): AccountCapabilities {
  const credentialMode = resolveStoredCredentialMode(account);
  return buildCapabilitiesFromCredentialMode(
    credentialMode,
    hasSessionTokenValue(account.accessToken),
  );
}

export function normalizeBatchIds(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => Number.parseInt(String(item), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
}

export function normalizePinnedFlag(input: unknown): boolean | null {
  if (input === undefined || input === null) return null;
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return input !== 0;
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
}

export function resolveRequestedCreateTokens(
  body: AccountCreatePayload,
  credentialMode: AccountCredentialMode,
): string[] {
  if (credentialMode !== 'apikey') {
    const single = String(body.accessToken || '').trim();
    return single ? [single] : [];
  }

  const batchTokens = parseBatchApiKeys(body.accessTokens);
  if (batchTokens.length > 0) return batchTokens;
  const tokens = parseBatchApiKeys(body.accessToken || body.apiToken);
  // Some platforms (e.g. opencode) need no API key at all — let the request
  // through with an empty token so the caller can skip model fetch.
  return tokens.length > 0 ? tokens : [''];
}

export function normalizeSortOrder(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const parsed = Number.parseInt(String(input), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed);
}

export function normalizeManagedRefreshToken(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeManagedTokenExpiresAt(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0)
    return Math.trunc(input);
  if (typeof input === 'string') {
    const parsed = Number.parseInt(input.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}


export type LoginFailureInfo = {
  message: string;
  shieldBlocked: boolean;
};


export const ACCOUNT_VERIFY_TIMEOUT_MS = 10_000;


export function normalizeLoginFailure(
  message: string | null | undefined,
): LoginFailureInfo {
  const raw = (message || '').trim();
  const lowered = raw.toLowerCase();
  const looksLikeHtmlJsonParseError =
    lowered.includes('unexpected token') &&
    lowered.includes('not valid json') &&
    (lowered.includes('<html') || lowered.includes('<script'));
  const looksLikeShieldChallenge =
    lowered.includes('acw_sc__v2') ||
    lowered.includes('var arg1') ||
    lowered.includes('captcha') ||
    lowered.includes('challenge') ||
    lowered.includes('cloudflare tunnel error');

  if (looksLikeHtmlJsonParseError || looksLikeShieldChallenge) {
    return {
      shieldBlocked: true,
      message:
        'This site is shielded by anti-bot challenge. Account/password login is blocked. Create an API key on the target site and import that key.',
    };
  }

  return {
    shieldBlocked: false,
    message: raw || 'login failed',
  };
}


export function isVerificationTimeoutError(error: unknown): boolean {
  const name =
    typeof error === 'object' && error && 'name' in error
      ? String((error as { name?: unknown }).name || '')
      : '';
  const message =
    typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message || '')
      : String(error || '');
  const lowered = `${name} ${message}`.toLowerCase();
  return (
    lowered.includes('timeout') ||
    lowered.includes('timed out') ||
    lowered.includes('abort')
  );
}

export function buildAccountVerifyTimeoutMessage(): string {
  return `Token verification timed out (${Math.max(1, Math.round(ACCOUNT_VERIFY_TIMEOUT_MS / 1000))}s)`;
}


export function resolveUserIdFailureReason(
  message: string,
  hasProvidedUserId: boolean,
): VerifyFailureReason {
  const lowered = String(message || '')
    .trim()
    .toLowerCase();
  if (!lowered) return null;

  if (
    lowered.includes('mismatch') ||
    lowered.includes('not match') ||
    lowered.includes('invalid user id') ||
    lowered.includes('wrong user id')
  ) {
    return 'invalid-user-id';
  }

  if (
    lowered.includes('missing new-api-user') ||
    lowered.includes('new-api-user required') ||
    lowered.includes('requires user id') ||
    lowered.includes('missing user id')
  ) {
    return 'needs-user-id';
  }

  if (lowered.includes('new-api-user') || lowered.includes('user id')) {
    return hasProvidedUserId ? 'invalid-user-id' : 'needs-user-id';
  }

  return null;
}

/**
 * Race a promise against a wall-clock deadline. Shared by the accounts route
 * modules (token verification, model fetch and health refresh) so there is a
 * single implementation of the timeout contract.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
