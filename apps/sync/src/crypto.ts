import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

export function randomId(): string {
  return randomToken(12);
}

/** Tokens are stored hashed so a leaked database can't be used to sign in. */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex');
}

// The key comes from the token itself (never stored; its hash is a different digest), so only someone
// holding the token can open what was sealed with it, also with a copy of the database.
function tokenKey(token: string): Buffer {
  return createHash('sha256').update(`openparley:seal:${token}`).digest();
}

/** Encrypts `plaintext` so that only the holder of `token` can read it back. */
export function sealWithToken(token: string, plaintext: string): string {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = createCipheriv('aes-256-gcm', tokenKey(token), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function openWithToken(token: string, sealed: string): string | null {
  try {
    const data = Buffer.from(sealed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', tokenKey(token), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' });
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}
