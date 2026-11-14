// A stand-in for GitHub's OAuth and the two API calls we make, for tests, `bun run dev:cloud` and e2e.
// `/login/oauth/authorize?login=<user>` approves straight away (automation); without it, a page to pick a user.

export interface FakeGithubUser {
  id: number;
  login: string;
  name: string | null;
  company?: string | null;
  emails: Array<{ email: string; primary: boolean; verified: boolean }>;
}

export const FAKE_GITHUB_USERS: FakeGithubUser[] = [
  { id: 1001, login: 'olivia-dev', name: 'Olivia', company: '@acme', emails: [{ email: 'olivia@acme.test', primary: true, verified: true }] },
  { id: 1002, login: 'mia-dev', name: 'Mia', company: null, emails: [{ email: 'mia@acme.test', primary: true, verified: true }] },
  { id: 1003, login: 'sam-unverified', name: null, emails: [{ email: 'sam@example.test', primary: true, verified: false }] },
];

export function startFakeGithub(options: { port?: number; users?: FakeGithubUser[] } = {}) {
  const users = new Map((options.users ?? FAKE_GITHUB_USERS).map((u) => [u.login, u]));
  const codes = new Map<string, string>();
  const tokens = new Map<string, string>();
  const random = () => crypto.randomUUID();
  const userFor = (request: Request) => users.get(tokens.get((request.headers.get('authorization') ?? '').replace(/^Bearer /, '')) ?? '');

  return Bun.serve({
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/login/oauth/authorize') {
        const redirect = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const login = url.searchParams.get('login');
        const approve = (who: string) => {
          const code = random();
          codes.set(code, who);
          const back = new URL(redirect);
          back.searchParams.set('code', code);
          back.searchParams.set('state', state);
          return Response.redirect(back.href, 302);
        };
        if (login && users.has(login)) return approve(login);
        const links = [...users.keys()].map((who) => `<li><a href="?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), login: who })}">${who}</a></li>`);
        return new Response(`<!doctype html><title>Fake GitHub</title><h1>Sign in to (fake) GitHub as</h1><ul>${links.join('')}</ul>`, { headers: { 'content-type': 'text/html' } });
      }
      if (url.pathname === '/login/oauth/access_token' && request.method === 'POST') {
        const form = new URLSearchParams(await request.text());
        const login = codes.get(form.get('code') ?? '');
        if (!login) return Response.json({ error: 'bad_verification_code' });
        codes.delete(form.get('code')!);
        const token = random();
        tokens.set(token, login);
        return Response.json({ access_token: token, token_type: 'bearer', scope: 'read:user,user:email' });
      }
      if (url.pathname === '/user') {
        const user = userFor(request);
        return user ? Response.json({ id: user.id, login: user.login, name: user.name, company: user.company ?? null }) : new Response('Unauthorized', { status: 401 });
      }
      if (url.pathname === '/user/emails') {
        const user = userFor(request);
        return user ? Response.json(user.emails) : new Response('Unauthorized', { status: 401 });
      }
      return new Response('Not found', { status: 404 });
    },
  });
}

if (import.meta.main) {
  const server = startFakeGithub({ port: Number(process.env.PORT ?? 4011) });
  console.log(`Fake GitHub on ${server.url}`);
}
