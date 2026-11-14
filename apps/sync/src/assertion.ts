import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomToken } from './crypto';

/**
 * Who someone is, as vouched for by a front door this server trusts (OpenParley Cloud, or a
 * self-hoster's own sign-in proxy) or by GitHub. Only `emailVerified: true` addresses can be
 * matched to existing accounts by email.
 */
export interface Identity {
  githubId?: string;
  githubLogin?: string;
  email?: string;
  emailVerified?: boolean;
  /** Every address the identity provider verified (GitHub lists several); `email` is the main one. */
  verifiedEmails?: string[];
  name?: string;
}

/** The addresses an identity proves someone reads. */
export function confirmedEmails(identity: Identity): string[] {
  if (identity.verifiedEmails) return identity.verifiedEmails;
  return identity.email && identity.emailVerified ? [identity.email] : [];
}

interface Claims extends Identity {
  /** The `PUBLIC_URL` it's for, so an assertion for one server never works on another. */
  aud: string;
  exp: number;
  /** Single use: the server remembers it until `exp`. */
  nonce: string;
}

/** Signs a sign-in assertion: valid for `ttlMs`, once, on the server at `audience`. */
export function signAssertion(key: string, audience: string, identity: Identity, ttlMs = 60_000, now = Date.now()): string {
  const claims: Claims = { ...identity, aud: audience, exp: now + ttlMs, nonce: randomToken(16) };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${mac(key, payload)}`;
}

/** The identity and nonce, or null when the signature, audience or expiry is wrong. The caller checks the nonce is unused. */
export function verifyAssertion(key: string, audience: string, token: string, now = Date.now()): { identity: Identity; nonce: string; exp: number } | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(key, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
  } catch {
    return null;
  }
  if (claims.aud !== audience || typeof claims.exp !== 'number' || claims.exp <= now || typeof claims.nonce !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 320 ? v : undefined);
  const identity: Identity = {
    githubId: str(claims.githubId),
    githubLogin: str(claims.githubLogin),
    email: str(claims.email)?.toLowerCase(),
    emailVerified: claims.emailVerified === true,
    verifiedEmails: Array.isArray(claims.verifiedEmails) ? claims.verifiedEmails.slice(0, 20).map(str).filter((e): e is string => !!e).map((e) => e.toLowerCase()) : undefined,
    name: str(claims.name),
  };
  return { identity, nonce: claims.nonce, exp: claims.exp };
}

function mac(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}
