import { describe, expect, test } from 'bun:test';
import { pkceChallenge, redirectMatches, redirectUriProblem } from '../src/oauth';
import { ACCESS_TOKEN_TTL } from '../src/repo';
import { harness, PUBLIC_URL } from './harness';

const REDIRECT = 'http://localhost:33418/callback';
const VERIFIER = 'a'.repeat(20) + '-verifier-' + 'b'.repeat(30);

async function setup() {
  const h = harness();
  const { b } = await h.owner();

  const register = async (metadata: Record<string, unknown> = {}) => {
    const res = await h.app.request(`${PUBLIC_URL}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...metadata }),
    });
    return { res, body: (await res.json()) as Record<string, any> };
  };

  const authorizeQuery = (clientId: string, overrides: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: pkceChallenge(VERIFIER),
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${PUBLIC_URL}/mcp`,
      ...overrides,
    });

  /** The URL the consent page sends the browser to. */
  const returnUrl = async (res: Response) => {
    const html = await res.text();
    const match = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(html);
    if (!match) throw new Error(`No redirect in (${res.status}): ${html.slice(0, 300)}`);
    return new URL(match[1]!.replaceAll('&amp;', '&'));
  };

  const approve = async (clientId: string, name = 'Claude Code', overrides: Record<string, string> = {}) => {
    const fields = Object.fromEntries(authorizeQuery(clientId, overrides));
    return returnUrl(await b.post('/oauth/authorize', { ...fields, name, decision: 'approve' }));
  };

  const token = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    h.app.request(`${PUBLIC_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields),
    });

  const exchange = async (clientId: string, code: string) =>
    token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: `${PUBLIC_URL}/mcp` });

  const mcp = (accessToken: string) =>
    h.app.request(`${PUBLIC_URL}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  return { ...h, b, register, authorizeQuery, approve, returnUrl, token, exchange, mcp };
}

describe('discovery', () => {
  test('an unauthenticated MCP request points to the resource metadata, which points to this server', async () => {
    const { app } = harness();
    const res = await app.request(`${PUBLIC_URL}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="threads"`);

    const bad = await app.request(`${PUBLIC_URL}/mcp`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer opa_nope' } });
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');

    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const prm = await app.request(`${PUBLIC_URL}${path}`, { headers: { origin: 'http://localhost:6274' } });
      expect(prm.headers.get('access-control-allow-origin')).toBe('*');
      expect(await prm.json()).toMatchObject({ resource: `${PUBLIC_URL}/mcp`, authorization_servers: [PUBLIC_URL] });
    }

    const as = (await (await app.request(`${PUBLIC_URL}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    });
  });
});

describe('registration', () => {
  test('accepts https, loopback http and app schemes; refuses the rest', async () => {
    expect(redirectUriProblem('https://claude.ai/api/mcp/auth_callback')).toBeNull();
    expect(redirectUriProblem('http://127.0.0.1:5555/cb')).toBeNull();
    expect(redirectUriProblem('cursor://anysphere.cursor-mcp/oauth/callback')).toBeNull();
    expect(redirectUriProblem('http://evil.example/cb')).not.toBeNull();
    expect(redirectUriProblem('javascript:alert(1)')).not.toBeNull();
    expect(redirectUriProblem('https://ok.example/cb#frag')).not.toBeNull();
    expect(redirectUriProblem('https://user:pw@ok.example/cb')).not.toBeNull();

    const { register } = await setup();
    expect((await register({ redirect_uris: ['http://evil.example/cb'] })).body.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: [] })).body.error).toBe('invalid_redirect_uri');
    expect((await register({ token_endpoint_auth_method: 'private_key_jwt' })).body.error).toBe('invalid_client_metadata');
    const ok = await register();
    expect(ok.res.status).toBe(201);
    expect(ok.body).toMatchObject({ client_name: 'Claude Code', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    expect(ok.body.client_secret).toBeUndefined();
  });

  test('a loopback redirect may change port, nothing else', () => {
    expect(redirectMatches(REDIRECT, 'http://localhost:51234/callback')).toBe(true);
    expect(redirectMatches(REDIRECT, 'http://localhost:51234/other')).toBe(false);
    expect(redirectMatches(REDIRECT, 'http://127.0.0.1:33418/callback')).toBe(false);
    expect(redirectMatches('https://app.example/cb', 'https://app.example:8443/cb')).toBe(false);
  });

  test('is rate limited per address', async () => {
    const { register } = await setup();
    for (let i = 0; i < 30; i++) expect((await register()).res.status).toBe(201);
    expect((await register()).res.status).toBe(429);
  });
});

describe('sign-in', () => {
  test('signed out: login first, then consent; approving gives a code that becomes a working agent', async () => {
    const { app, repo, register, authorizeQuery, browser, b, approve, exchange, mcp } = await setup();
    const { client_id } = (await register()).body;

    const stranger = browser();
    const login = await stranger.request(`/oauth/authorize?${authorizeQuery(client_id)}`);
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toStartWith('/login?next=%2Foauth%2Fauthorize%3F');

    const consent = await (await b.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text();
    expect(consent).toContain('Connect an agent?');
    expect(consent).toContain('an app on this computer (localhost:33418)');
    expect(consent).toContain('value="Claude Code"');

    const back = await approve(client_id, 'Claude Code on laptop');
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(PUBLIC_URL);
    const code = back.searchParams.get('code')!;

    const res = await exchange(client_id, code);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const tokens = (await res.json()) as Record<string, any>;
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL / 1000, scope: 'threads' });
    expect(tokens.access_token).toStartWith('opa_');
    expect(tokens.refresh_token).toStartWith('opr_');

    expect((await mcp(tokens.access_token)).status).toBe(200);
    // The code works once.
    expect(((await (await exchange(client_id, code)).json()) as any).error).toBe('invalid_grant');

    const owner = repo.listActiveUsers()[0]!;
    expect(repo.listAgentTokens(owner.id)).toMatchObject([{ name: 'Claude Code on laptop', clientId: client_id }]);
    const admin = await (await b.request('/admin')).text();
    expect(admin).toContain('Claude Code on laptop');
    expect(admin).toContain('signed in');
    void app;
  });

  test('cancel sends access_denied back; unknown clients and redirects never leave this site', async () => {
    const { register, authorizeQuery, b, returnUrl } = await setup();
    const { client_id } = (await register()).body;

    const denied = await returnUrl(await b.post('/oauth/authorize', { ...Object.fromEntries(authorizeQuery(client_id)), decision: 'deny' }));
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.get('code')).toBeNull();

    const unknown = await b.request(`/oauth/authorize?${authorizeQuery('nope')}`);
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).not.toContain('http-equiv');
    const elsewhere = await b.request(`/oauth/authorize?${authorizeQuery(client_id, { redirect_uri: 'https://evil.example/cb' })}`);
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).not.toContain('evil.example');

    const noPkce = await returnUrl(await b.request(`/oauth/authorize?${authorizeQuery(client_id, { code_challenge_method: 'plain' })}`));
    expect(noPkce.searchParams.get('error')).toBe('invalid_request');
    const otherResource = await returnUrl(await b.request(`/oauth/authorize?${authorizeQuery(client_id, { resource: 'https://other.example/mcp' })}`));
    expect(otherResource.searchParams.get('error')).toBe('invalid_target');
  });

  test('the consent form is protected against cross-site posts', async () => {
    const { register, authorizeQuery, b } = await setup();
    const { client_id } = (await register()).body;
    const res = await b.post('/oauth/authorize', { ...Object.fromEntries(authorizeQuery(client_id)), name: 'x', decision: 'approve' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  test('a wrong verifier, client or redirect doesn\u2019t get a token', async () => {
    const { register, approve, token } = await setup();
    const { client_id } = (await register()).body;
    const other = (await register()).body.client_id;
    const base = { grant_type: 'authorization_code', redirect_uri: REDIRECT, code_verifier: VERIFIER };

    const wrongVerifier = (await approve(client_id)).searchParams.get('code')!;
    expect((await (await token({ ...base, code: wrongVerifier, client_id, code_verifier: 'x'.repeat(50) })).json()) as any).toMatchObject({ error: 'invalid_grant' });
    const wrongClient = (await approve(client_id)).searchParams.get('code')!;
    expect((await (await token({ ...base, code: wrongClient, client_id: other })).json()) as any).toMatchObject({ error: 'invalid_grant' });
    const wrongRedirect = (await approve(client_id)).searchParams.get('code')!;
    expect((await (await token({ ...base, code: wrongRedirect, client_id, redirect_uri: 'http://localhost:1/x' })).json()) as any).toMatchObject({ error: 'invalid_grant' });
    expect((await token({ ...base, code: 'x', client_id: 'unknown' })).status).toBe(401);
  });
});

describe('tokens', () => {
  test('refresh rotates both tokens; revoking on the admin page ends the sign-in', async () => {
    const { repo, register, approve, exchange, token, mcp, b } = await setup();
    const { client_id } = (await register()).body;
    const first = (await (await exchange(client_id, (await approve(client_id)).searchParams.get('code')!)).json()) as Record<string, string>;

    const refreshed = (await (await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token!, client_id })).json()) as Record<string, string>;
    expect(refreshed.access_token).not.toBe(first.access_token);
    expect((await mcp(first.access_token!)).status).toBe(401);
    expect((await mcp(refreshed.access_token!)).status).toBe(200);

    const owner = repo.listActiveUsers()[0]!;
    const [agent] = repo.listAgentTokens(owner.id);
    await b.post(`/admin/agents/${agent!.id}/revoke`, {});
    expect((await mcp(refreshed.access_token!)).status).toBe(401);
    expect(((await (await token({ grant_type: 'refresh_token', refresh_token: refreshed.refresh_token!, client_id })).json()) as any).error).toBe('invalid_grant');
  });

  test('a refresh token that was just rotated gets the same tokens again, then stops working', async () => {
    const { repo, register, approve, exchange, token, mcp } = await setup();
    const db = (repo as unknown as { db: import('bun:sqlite').Database }).db;
    const { client_id } = (await register()).body;
    const other = (await register()).body.client_id;
    const first = (await (await exchange(client_id, (await approve(client_id)).searchParams.get('code')!)).json()) as Record<string, any>;
    const refresh = async (refresh_token: string, id = client_id) =>
      (await (await token({ grant_type: 'refresh_token', refresh_token, client_id: id })).json()) as Record<string, any>;

    // Two sessions waking up together both refresh with the same token: both keep a working sign-in.
    const a = await refresh(first.refresh_token);
    const b = await refresh(first.refresh_token);
    expect(b.access_token).toBe(a.access_token);
    expect(b.refresh_token).toBe(a.refresh_token);
    expect(b.expires_in).toBeGreaterThan(0);
    expect(b.expires_in).toBeLessThanOrEqual(ACCESS_TOKEN_TTL / 1000);
    expect((await mcp(a.access_token)).status).toBe(200);
    expect((await refresh(first.refresh_token, other)).error).toBe('invalid_grant');

    // The next rotation moves on: the token from two rotations ago is no longer answered.
    const c = await refresh(a.refresh_token);
    expect(c.access_token).not.toBe(a.access_token);
    expect((await refresh(first.refresh_token)).error).toBe('invalid_grant');
    expect((await refresh(a.refresh_token)).access_token).toBe(c.access_token);

    db.query('UPDATE agent_tokens SET previous_refresh_until = $now').run({ now: Date.now() });
    expect((await refresh(a.refresh_token)).error).toBe('invalid_grant');
    const d = await refresh(c.refresh_token);
    expect((await mcp(d.access_token)).status).toBe(200);
    const stored = JSON.stringify(db.query('SELECT * FROM agent_tokens').all());
    expect(stored).not.toContain(d.access_token.slice(4));
    expect(stored).not.toContain(d.refresh_token.slice(4));
  });

  test('access tokens expire', async () => {
    const { db, register, approve, exchange, mcp } = await (async () => {
      const s = await setup();
      return { ...s, db: (s.repo as unknown as { db: import('bun:sqlite').Database }).db };
    })();
    const { client_id } = (await register()).body;
    const { access_token } = (await (await exchange(client_id, (await approve(client_id)).searchParams.get('code')!)).json()) as Record<string, string>;
    db.query('UPDATE agent_tokens SET token_expires_at = 1').run();
    const res = await mcp(access_token!);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  test('signing in again with the same client replaces the earlier sign-in', async () => {
    const { repo, register, approve, exchange, mcp } = await setup();
    const { client_id } = (await register()).body;
    const first = (await (await exchange(client_id, (await approve(client_id)).searchParams.get('code')!)).json()) as Record<string, string>;
    const second = (await (await exchange(client_id, (await approve(client_id, 'Claude Code 2')).searchParams.get('code')!)).json()) as Record<string, string>;
    expect((await mcp(first.access_token!)).status).toBe(401);
    expect((await mcp(second.access_token!)).status).toBe(200);
    expect(repo.listAgentTokens(repo.listActiveUsers()[0]!.id).map((a) => a.name)).toEqual(['Claude Code 2']);
  });

  test('the revocation endpoint ends a sign-in by either token', async () => {
    const { register, approve, exchange, token, mcp, app } = await setup();
    const { client_id } = (await register()).body;
    const tokens = (await (await exchange(client_id, (await approve(client_id)).searchParams.get('code')!)).json()) as Record<string, string>;
    const res = await app.request(`${PUBLIC_URL}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refresh_token!, client_id }),
    });
    expect(res.status).toBe(200);
    expect((await mcp(tokens.access_token!)).status).toBe(401);
    void token;
  });

  test('confidential clients must send their secret', async () => {
    const { register, approve, token } = await setup();
    const { client_id, client_secret } = (await register({ token_endpoint_auth_method: 'client_secret_basic' })).body;
    expect(client_secret).toBeString();
    const fields = (code: string) => ({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    const withoutSecret = await token({ ...fields((await approve(client_id)).searchParams.get('code')!), client_id });
    expect(withoutSecret.status).toBe(401);
    const basic = `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString('base64')}`;
    const withSecret = await token(fields((await approve(client_id)).searchParams.get('code')!), { authorization: basic });
    expect(withSecret.status).toBe(200);
  });

  test('removing a user ends their sign-ins', async () => {
    const { repo, register, approve, exchange, mcp, b, invited } = await setup();
    const { client_id } = (await register()).body;
    const member = await invited(b, 'member', 'mia@example.com');
    const consent = await member.b.request(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: pkceChallenge(VERIFIER), code_challenge_method: 'S256' })}`);
    expect(consent.status).toBe(200);
    const fields = { response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: pkceChallenge(VERIFIER), code_challenge_method: 'S256', name: 'Mia agent', decision: 'approve' };
    const html = await (await member.b.post('/oauth/authorize', fields)).text();
    const code = new URL(/url=([^"]+)"/.exec(html)![1]!.replaceAll('&amp;', '&')).searchParams.get('code')!;
    const tokens = (await (await exchange(client_id, code)).json()) as Record<string, string>;
    expect((await mcp(tokens.access_token!)).status).toBe(200);

    const mia = repo.listActiveUsers().find((u) => u.email === 'mia@example.com')!;
    await b.post(`/admin/members/${mia.id}`, { action: 'remove', confirm: 'yes' });
    expect((await mcp(tokens.access_token!)).status).toBe(401);
    void approve;
  });
});
