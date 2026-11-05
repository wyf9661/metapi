import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { encryptCredential } from '../shared/credentialCrypto.js';
import { downstreamApiKeys, sites } from './schema.js';

/**
 * A database whose rows were sealed under a secret that is no longer configured
 * must still be readable as a table: presenting the value as empty lets the UI
 * open and the user re-enter it, where throwing 500s every route that selects
 * the column.
 */
describe('encrypted column reads tolerate an unstuck key', () => {
  let originalSecret: string;

  beforeEach(() => {
    originalSecret = config.accountCredentialSecret;
    config.accountCredentialSecret = 'schema-read-test-secret-32chars';
  });

  afterEach(() => {
    config.accountCredentialSecret = originalSecret;
  });

  it('decrypts values sealed under the configured secret', () => {
    const sealed = encryptCredential('sk-live-key', 'site.api_key');
    expect(sites.apiKey.mapFromDriverValue(sealed)).toBe('sk-live-key');
  });

  it('returns an empty credential instead of throwing when the key is gone', () => {
    const sealed = encryptCredential('sk-live-key', 'site.api_key');
    config.accountCredentialSecret = 'a-completely-different-secret-32';

    expect(() => sites.apiKey.mapFromDriverValue(sealed)).not.toThrow();
    expect(sites.apiKey.mapFromDriverValue(sealed)).toBe('');
  });

  it('keeps unreadable downstream keys out of the equality lookup as empty', () => {
    const sealed = encryptCredential('sk-downstream-abc', 'downstream.key', { deterministic: true });
    config.accountCredentialSecret = 'a-completely-different-secret-32';

    expect(downstreamApiKeys.key.mapFromDriverValue(sealed)).toBe('');
  });

  it('passes plaintext and blank values through untouched', () => {
    expect(sites.apiKey.mapFromDriverValue('legacy-plaintext-key')).toBe('legacy-plaintext-key');
    expect(sites.apiKey.mapFromDriverValue('')).toBe('');
  });
});
