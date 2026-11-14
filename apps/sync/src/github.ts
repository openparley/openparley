import type { Identity } from './assertion';

export interface GithubApp {
  clientId: string;
  clientSecret: string;
  /** Overrides for tests and development (a fake GitHub). */
  apiUrl?: string;
  webUrl?: string;
}

const web = (app: GithubApp) => (app.webUrl ?? 'https://github.com').replace(/\/+$/, '');
const api = (app: GithubApp) => (app.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');

/** Where to send the browser. `read:user user:email` is the least that shows a verified email. */
export function githubAuthorizeUrl(app: GithubApp, redirectUri: string, state: string): string {
  const params = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, scope: 'read:user user:email', state, allow_signup: 'true' });
  return `${web(app)}/login/oauth/authorize?${params}`;
}

/**
 * Exchanges the callback's code for who signed in. The email is the primary one, and only when GitHub
 * verified it; `verifiedEmails` lists all verified ones, so an account here can match a secondary address.
 * The access token is used for these two calls and then dropped.
 */
export async function githubIdentity(app: GithubApp, code: string, redirectUri: string, fetchFn: typeof fetch = fetch): Promise<Identity & { verifiedEmails: string[] }> {
  const tokenRes = await fetchFn(`${web(app)}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  });
  const token = ((await tokenRes.json().catch(() => ({}))) as { access_token?: string }).access_token;
  if (!tokenRes.ok || !token) throw new Error(`GitHub didn't accept the sign-in code (${tokenRes.status}).`);
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchFn(`${api(app)}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'OpenParley' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub ${path} failed (${res.status}).`);
    return (await res.json()) as T;
  };
  const [user, emails] = await Promise.all([
    get<{ id: number; login: string; name: string | null; company?: string | null }>('/user'),
    get<Array<{ email: string; primary: boolean; verified: boolean }>>('/user/emails'),
  ]);
  const verified = emails.filter((e) => e.verified);
  const primary = verified.find((e) => e.primary) ?? verified[0];
  return {
    githubId: String(user.id),
    githubLogin: user.login,
    name: user.name ?? undefined,
    email: primary?.email.toLowerCase(),
    emailVerified: !!primary,
    verifiedEmails: verified.map((e) => e.email.toLowerCase()),
  };
}
