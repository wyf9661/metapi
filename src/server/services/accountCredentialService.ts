import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

function buildKey(): Buffer {
  const secret = (config.accountCredentialSecret || '').trim() || config.authToken || 'change-me-admin-token'; // local/dev fallback only
  return createHash('sha256').update(secret).digest();
}

export function encryptAccountPassword(password: string): string {
  const key = buildKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function decryptAccountPassword(cipherText: string): string | null {
  const parts = (cipherText || '').split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const [, ivRaw, tagRaw, dataRaw] = parts;
    const key = buildKey();
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
