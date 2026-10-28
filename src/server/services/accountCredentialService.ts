import { decryptCredential, encryptRandomCredential } from '../shared/credentialCrypto.js';

export function encryptAccountPassword(password: string): string {
  return encryptRandomCredential(password);
}

export function decryptAccountPassword(cipherText: string): string | null {
  return decryptCredential(cipherText);
}
