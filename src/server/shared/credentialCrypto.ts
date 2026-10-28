import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const VERSION_V1 = 'v1';
const VERSION_V2 = 'v2';
const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_RE = /^v\d+:/;
const HKDF_SALT = 'metapi-credential-v1';

export type CredentialPurpose =
  | 'password'
  | 'site.api_key'
  | 'account.access_token'
  | 'account.api_token'
  | 'account_token.token'
  | 'downstream.key';

function secret(): string {
  return (config.accountCredentialSecret || '').trim() || config.authToken || 'change-me-admin-token';
}

/** Legacy v1 derivation: one SHA-256 key for everything (still needed to read old rows). */
function legacyKey(): Buffer {
  return createHash('sha256').update(secret()).digest();
}

/** v2 derivation: one subkey per purpose, so one column's key cannot unwrap another. */
function purposeKey(purpose: CredentialPurpose): Buffer {
  const derived = hkdfSync(
    'sha256',
    Buffer.from(secret(), 'utf8'),
    Buffer.from(HKDF_SALT, 'utf8'),
    Buffer.from(purpose, 'utf8'),
    32,
  );
  return Buffer.from(derived);
}

function sealWith(key: Buffer, plain: string, iv: Buffer, version: string): string {
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    version,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function isEncryptedCredential(value: string | null | undefined): boolean {
  return typeof value === 'string' && ENVELOPE_RE.test(value);
}

/**
 * Seal a credential with a purpose-scoped HKDF subkey.
 *
 * `deterministic: true` keeps identical plaintext producing identical
 * ciphertext so equality lookups (`WHERE key = ?`) keep working. That leaks
 * equality only; use it solely where the column is queried by value.
 */
export function encryptCredential(
  plain: string,
  purpose: CredentialPurpose,
  options: { deterministic?: boolean } = {},
): string {
  const key = purposeKey(purpose);
  const iv = options.deterministic
    ? createHmac('sha256', key).update('det:').update(plain, 'utf8').digest().subarray(0, 12)
    : randomBytes(12);
  return sealWith(key, plain, iv, VERSION_V2);
}

/** Random-IV envelope, used for passwords and other write-only secrets. */
export function encryptRandomCredential(plain: string, purpose: CredentialPurpose = 'password'): string {
  return sealWith(purposeKey(purpose), plain, randomBytes(12), VERSION_V2);
}

export function decryptCredential(
  cipherText: string,
  purpose: CredentialPurpose = 'password',
): string | null {
  const parts = (cipherText || '').split(':');
  if (parts.length !== 4) return null;
  const version = parts[0];
  if (version !== VERSION_V1 && version !== VERSION_V2) return null;

  try {
    const [, ivRaw, tagRaw, dataRaw] = parts;
    const key = version === VERSION_V2 ? purposeKey(purpose) : legacyKey();
    const iv = Buffer.from(ivRaw, 'base64url');
    const tag = Buffer.from(tagRaw, 'base64url');
    const data = Buffer.from(dataRaw, 'base64url');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Read a stored credential. Legacy plaintext passes through unchanged;
 * versioned envelopes are decrypted with the purpose key (v2) or the legacy
 * single key (v1). A malformed envelope fails closed instead of forwarding
 * ciphertext as a credential.
 */
export function readCredential(value: string, purpose: CredentialPurpose): string {
  if (!isEncryptedCredential(value)) return value;
  const plain = decryptCredential(value, purpose);
  if (plain === null) throw new Error(`Credential decryption failed (${purpose})`);
  return plain;
}
