import { createCipheriv, createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import {
  decryptCredential,
  encryptCredential,
  encryptRandomCredential,
  isEncryptedCredential,
  readCredential,
} from './credentialCrypto.js';

describe('credential crypto', () => {
  let originalSecret: string;

  beforeEach(() => {
    originalSecret = config.accountCredentialSecret;
    config.accountCredentialSecret = 'credential-crypto-test-secret';
  });

  afterEach(() => {
    config.accountCredentialSecret = originalSecret;
  });

  it('seals values and round-trips them', () => {
    const sealed = encryptCredential('sk-test-123', 'account.api_token');
    expect(isEncryptedCredential(sealed)).toBe(true);
    expect(sealed).not.toContain('sk-test-123');
    expect(decryptCredential(sealed, 'account.api_token')).toBe('sk-test-123');
  });

  it('is deterministic so equality lookups keep working', () => {
    expect(encryptCredential('sk-same', 'downstream.key', { deterministic: true })).toBe(encryptCredential('sk-same', 'downstream.key', { deterministic: true }));
    expect(encryptCredential('sk-same', 'downstream.key', { deterministic: true })).not.toBe(encryptCredential('sk-other', 'downstream.key', { deterministic: true }));
  });

  it('uses a random IV for write-only secrets', () => {
    expect(encryptRandomCredential('password')).not.toBe(encryptRandomCredential('password'));
  });

  it('passes legacy plaintext through unchanged', () => {
    expect(isEncryptedCredential('sk-legacy')).toBe(false);
    expect(readCredential('sk-legacy', 'account.api_token')).toBe('sk-legacy');
  });

  it('fails closed on a malformed envelope', () => {
    expect(decryptCredential('v1:bad', 'account.api_token')).toBeNull();
    expect(() => readCredential('v1:bad:bad:bad', 'account.api_token')).toThrow(/decryption failed/i);
  });

  it('still decrypts legacy v1 envelopes written with the old single key', () => {
    // Recreate the pre-upgrade scheme: SHA-256(secret), random IV, `v1:` tag.
    const key = createHash('sha256').update(config.accountCredentialSecret).digest();
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update('legacy-v1-secret', 'utf8'), cipher.final()]);
    const envelope = ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');

    expect(decryptCredential(envelope, 'password')).toBe('legacy-v1-secret');
    // v1 predates purpose scoping: the legacy key is intentionally purpose-agnostic.
    expect(decryptCredential(envelope, 'account.api_token')).toBe('legacy-v1-secret');
  });
});
