import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pkceChallenge, type Mail } from '@openparley/sync';
import { startFakeGithub } from '../../../apps/sync/dev/fake-github';
import { Cloud } from '../src/cloud';
import { loadCloudConfig } from '../src/config';

const DOMAIN = 'parley.test';
const CONTROL = `https://cloud.${DOMAIN}`;
const MCP = `https://mcp.${DOMAIN}`;
const REDIRECT = 'http://127.0.0.1:33418/callback';
const VERIFIER = 'v'.repeat(30) + '-agent-verifier-' + 'w'.repeat(20);
const github = startFakeGithub();
afterAll(() => github.stop(true));
const clouds: Cloud[] = [];
afterEach(() => {
  for (const cloud of clouds.splice(0)) cloud.close();
});

function makeCloud() {
  const mails: Mail[] = [];
  const config = {
    ...loadCloudConfig({ CLOUD_DOMAIN: DOMAIN, DATA_DIR: mkdtempSync(join(tmpdir(), 'openparley-broker-')) }),
    overlayDir: '/nonexistent',
    github: { clientId: 'cloud', clientSecret: 'secret', webUrl: github.url.origin, apiUrl: github.url.origin },
  };
  const cloud = new Cloud(config, { mailer: { send: async (mail) => void mails.push(mail) } });
  clouds.push(cloud);
  return { cloud, mails };
}

/** A browser across Cloud's hosts that follows redirects (also meta refreshes), through the fake GitHub, and stops at the agent's callback. */
function browser(cloud: Cloud, githubLogin = 'olivia-dev') {
  const jars = new Map<string, Map<string, string>>();
  const send = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(url);
    if (target.origin === github.url.origin) {
      if (target.pathname === '/login/oauth/authorize') target.searchParams.set('login', githubLogin);
      return fetch(target, { redirect: 'manual' });
    }
    const jar = jars.get(target.host) ?? new Map<string, string>();
    jars.set(target.host, jar);
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    if (init.method === 'POST' && !headers.has('origin')) headers.set('origin', target.origin);
    const res = await cloud.fetch(new Request(target, { ...init, headers, redirect: 'manual' }));
    for (const set of res.headers.getSetCookie()) {
      const [name, value = ''] = set.split(';')[0]!.split('=');
      if (set.includes('Max-Age=0') || !value) jar.delete(name!);
      else jar.set(name!, value);
    }
    return res;
  };
  const go = async (url: string, init: RequestInit = {}) => {
    let res = await send(url, init);
    let at = url;
    for (let hops = 0; hops < 12; hops++) {
      let next: string | null = null;
      if (res.status >= 300 && res.status < 400) next = res.headers.get('location');
      else if (res.status === 200) {
        const html = await res.clone().text();
        next = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&') ?? null;
      }
      if (!next) break;
      at = new URL(next, at).href;
      if (at.startsWith(REDIRECT)) return { res, url: at, html: '' };
      res = await send(at);
    }
    return { res, url: at, html: await res.text() };
  };
  const post = (url: string, fields: Record<string, string>) =>
    go(url, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { go, post };
}

const hiddenInputs = (html: string) =>
  Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1]!, m[2]!.replaceAll('&amp;', '&')]));

async function workspace(cloud: Cloud, slug: string) {
  const { tenant, setupUrl } = cloud.provision({ slug, name: slug[0]!.toUpperCase() + slug.slice(1) });
  const owner = browser(cloud);
  const setup = new URL(setupUrl);
  await owner.post(`${setup.origin}/setup`, { token: setup.searchParams.get('token')!, name: 'Olivia', email: 'olivia@acme.test', password: 'correct horse battery' });
  return { tenant, owner, url: setup.origin };
}

async function register(cloud: Cloud) {
  const res = await cloud.fetch(
    new Request(`${CONTROL}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

const authorizeUrl = (clientId: string) =>
  `${CONTROL}/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    state: 'agent-state',
    resource: `${MCP}/mcp`,
  })}`;

const token = (cloud: Cloud, fields: Record<string, string>) =>
  cloud.fetch(new Request(`${CONTROL}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }));

const mcp = (cloud: Cloud, accessToken: string, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) =>
  cloud.fetch(
    new Request(`${MCP}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    }),
  );

describe('one MCP URL for every workspace', () => {
  test('discovery: the resource on mcp.<domain>, its sign-in on cloud.<domain>', async () => {
    const { cloud } = makeCloud();
    const unauthorized = await mcp(cloud, 'nope');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain(`resource_metadata="${MCP}/.well-known/oauth-protected-resource/mcp"`);
    const resource = (await (await cloud.fetch(new Request(`${MCP}/.well-known/oauth-protected-resource/mcp`))).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: `${MCP}/mcp`, authorization_servers: [CONTROL] });
    const server = (await (await cloud.fetch(new Request(`${CONTROL}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>;
    expect(server).toMatchObject({ issuer: CONTROL, registration_endpoint: `${CONTROL}/oauth/register`, code_challenge_methods_supported: ['S256'] });
  });

  test('sign in, the only workspace is picked, approve on its consent page; the agent works, refreshes and revokes', async () => {
    const { cloud, mails } = makeCloud();
    const { url, owner, tenant } = await workspace(cloud, 'acme');
    // Confirm the owner's email so the Cloud account finds the workspace.
    await owner.post(`${url}/admin/email-confirmation`, {});
    await owner.post(/(https:\/\/\S+\/confirm-email\/\S+)/.exec(mails.at(-1)!.text)![1]!, {});

    const clientId = await register(cloud);
    const me = browser(cloud);
    // Not signed in: Cloud's sign-in first, then straight to the workspace's consent page (one workspace).
    const login = await me.go(authorizeUrl(clientId));
    expect(login.url).toStartWith(`${CONTROL}/login`);
    const consent = await me.go(`${CONTROL}/auth/github?${new URLSearchParams({ next: new URL(login.url).searchParams.get('next')! })}`);
    expect(consent.url).toStartWith(`${url}/oauth/authorize`);
    expect(consent.html).toContain('Connect an agent?');
    expect(consent.html).toContain('Claude Code');

    const back = await me.post(`${url}/oauth/authorize`, { ...hiddenInputs(consent.html), name: 'Claude Code', decision: 'approve' });
    const callback = new URL(back.url);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    expect(callback.searchParams.get('state')).toBe('agent-state');
    expect(callback.searchParams.get('iss')).toBe(CONTROL);

    const issued = (await (await token(cloud, { grant_type: 'authorization_code', code: callback.searchParams.get('code')!, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT })).json()) as Record<string, string>;
    expect(issued.access_token).toStartWith(`${tenant.id}.opa_`);
    expect(issued.refresh_token).toStartWith(`${tenant.id}.opr_`);
    // The code works once.
    expect((await token(cloud, { grant_type: 'authorization_code', code: callback.searchParams.get('code')!, code_verifier: VERIFIER, client_id: clientId })).status).toBe(400);

    const tools = await mcp(cloud, issued.access_token!);
    expect(tools.status).toBe(200);
    expect(JSON.stringify(await tools.json())).toContain('list_threads');
    // The agent shows up on the workspace's admin page like any other.
    expect((await owner.go(`${url}/admin`)).html).toContain('Claude Code');

    const refreshed = (await (await token(cloud, { grant_type: 'refresh_token', refresh_token: issued.refresh_token!, client_id: clientId })).json()) as Record<string, string>;
    expect(refreshed.access_token).toStartWith(`${tenant.id}.opa_`);
    expect(refreshed.access_token).not.toBe(issued.access_token);
    expect((await mcp(cloud, refreshed.access_token!)).status).toBe(200);

    await cloud.fetch(new Request(`${CONTROL}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshed.access_token!, client_id: clientId }) }));
    const revoked = await mcp(cloud, refreshed.access_token!);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get('www-authenticate')).toContain(`${MCP}/.well-known/oauth-protected-resource/mcp`);
  });

  test('several workspaces: pick one; a token for one workspace never works on another', async () => {
    const { cloud } = makeCloud();
    await workspace(cloud, 'acme');
    await workspace(cloud, 'globex');
    for (const slug of ['acme', 'globex']) {
      const repo = cloud.workspaceRepo(cloud.control.find(slug)!);
      repo.markEmailVerified(repo.listActiveUsers()[0]!.id);
    }
    const clientId = await register(cloud);
    const me = browser(cloud);
    await me.go(`${CONTROL}/auth/github`);
    const picker = await me.go(authorizeUrl(clientId));
    expect(picker.html).toContain('Which workspace should it work in?');
    const globex = cloud.control.find('globex')!;
    const consent = await me.post(`${CONTROL}/oauth/authorize`, { request: hiddenInputs(picker.html).request!, workspace: globex.id });
    expect(consent.url).toStartWith('https://globex.parley.test/oauth/authorize');
    const back = new URL((await me.post('https://globex.parley.test/oauth/authorize', { ...hiddenInputs(consent.html), name: 'Claude Code', decision: 'approve' })).url);
    const issued = (await (await token(cloud, { grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: VERIFIER, client_id: clientId })).json()) as Record<string, string>;
    expect(issued.access_token).toStartWith(`${globex.id}.`);
    const acme = cloud.control.find('acme')!;
    expect((await mcp(cloud, issued.access_token!.replace(globex.id, acme.id))).status).toBe(401);
    // A paused workspace's agents stop too.
    cloud.control.update('globex', { status: 'suspended' });
    expect((await mcp(cloud, issued.access_token!)).status).toBe(402);
  });

  test('no workspace yet: create one from the picker and come straight back', async () => {
    const { cloud } = makeCloud();
    const clientId = await register(cloud);
    const me = browser(cloud);
    await me.go(`${CONTROL}/auth/github`);
    const picker = await me.go(authorizeUrl(clientId));
    expect(picker.html).toContain('Create a workspace');
    // Sign-up is closed without Polar; the link still carries the way back.
    expect(picker.html).toContain(`/signup?plan=free&amp;next=${encodeURIComponent('/oauth/authorize?')}`);
  });

  test('declining on the consent page tells the agent', async () => {
    const { cloud, mails } = makeCloud();
    const { url, owner } = await workspace(cloud, 'acme');
    await owner.post(`${url}/admin/email-confirmation`, {});
    await owner.post(/(https:\/\/\S+\/confirm-email\/\S+)/.exec(mails.at(-1)!.text)![1]!, {});
    const clientId = await register(cloud);
    const me = browser(cloud);
    await me.go(`${CONTROL}/auth/github`);
    const consent = await me.go(authorizeUrl(clientId));
    const back = new URL((await me.post(`${url}/oauth/authorize`, { ...hiddenInputs(consent.html), decision: 'deny' })).url);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('agent-state');
  });

  test('unknown clients and redirects stay on our page', async () => {
    const { cloud } = makeCloud();
    const res = await cloud.fetch(new Request(`${CONTROL}/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent('https://evil.test/')}`));
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });
});
