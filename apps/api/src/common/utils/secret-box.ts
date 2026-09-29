import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { env } from '../../config/env';

const VERSION = 'v1';

/** 32-byte key from SETTINGS_ENCRYPTION_KEY (hex, base64 or passphrase); outside production it may fall back to the JWT secret. */
export function encryptionKey(e = env()): Buffer {
  const raw = e.SETTINGS_ENCRYPTION_KEY ?? `settings:${e.JWT_ACCESS_SECRET}`;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32 && b64.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) return b64;
  return createHash('sha256').update(raw).digest();
}

/** AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). */
export function seal(plain: string, key = encryptionKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function open(sealed: string, key = encryptionKey()): string {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error('Unrecognised sealed value');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export const sealJson = (value: Record<string, unknown>, key?: Buffer) => seal(JSON.stringify(value), key);
export const openJson = <T = Record<string, string>>(sealed: string, key?: Buffer): T => JSON.parse(open(sealed, key)) as T;

/** Last four characters for display, e.g. `****9f2a`. */
export const secretHint = (value: string | undefined | null) => (value ? `****${value.slice(-4)}` : null);
