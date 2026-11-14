/** @jsxImportSource hono/jsx */
import type { Database } from 'bun:sqlite';
import {
  hashToken,
  openWithToken,
  pkceChallenge,
  randomToken,
  RateLimiter,
  redirectMatches,
  redirectUriProblem,
  sealWithToken,
} from '@openparley/sync';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { AccountEnv } from './account-routes';
import { AccountAside } from './account-routes';
import type { Cloud } from './cloud';
import type { Tenant } from './control';
import { Message, Page } from './views';

// One MCP URL for every Cloud workspace: https://mcp.<domain>/mcp. Its authorization server is the control
// plane (where the Cloud account session lives). After you pick a workspace, Cloud signs you in there and
// runs that workspace's own OAuth as an ordinary client, so you approve the agent on the workspace's
// consent page and the workspace issues the tokens. The agent gets them prefixed with the workspace id
// (`<id>.opa_…`); Cloud keeps no token map, strips the prefix and forwards to that workspace, which
// checks the token itself.

const SCOPE = 'threads';
const REQUEST_TTL = 10 * 60 * 1000;
const CODE_TTL = 5 * 60 * 1000;
const UNUSED_CLIENT_TTL = 7 * 24 * 60 * 60 * 1000;

interface McpClient {
  id: string;
  name: string;
  redirectUris: string[];
  secretHash: string | null;
}

interface PendingRequest {
  id: string;
  accountId: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  tenantId: string | null;
  verifier: string | null;
}

interface IssuedTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/** The broker's tables in control.db. */
export class BrokerStore {
  constructor(private readonly db: Database) {}

  registerClient(name: string, redirectUris: string[], confidential: boolean): { client: McpClient; secret: string | null } {
    const now = Date.now();
    // Registrations that never led to a sign-in.
    this.db
      .query('DELETE FROM mcp_clients WHERE created_at <= $before AND id NOT IN (SELECT mcp_client_id FROM mcp_workspace_clients)')
      .run({ before: now - UNUSED_CLIENT_TTL });
    const secret = confidential ? randomToken() : null;
    const client: McpClient = { id: randomToken(12), name, redirectUris, secretHash: secret && hashToken(secret) };
    this.db
      .query('INSERT INTO mcp_clients (id, name, redirect_uris, secret_hash, created_at) VALUES ($id, $name, $uris, $secretHash, $now)')
      .run({ id: client.id, name, uris: JSON.stringify(redirectUris), secretHash: client.secretHash, now });
    return { client, secret };
  }

  findClient(id: string): McpClient | null {
    const row = this.db
      .query<{ id: string; name: string; redirect_uris: string; secret_hash: string | null }, { id: string }>('SELECT * FROM mcp_clients WHERE id = $id')
      .get({ id });
    return row && { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris), secretHash: row.secret_hash };
  }

  workspaceClient(clientId: string, tenantId: string): string | null {
    return (
      this.db
        .query<{ workspace_client_id: string }, { clientId: string; tenantId: string }>(
          'SELECT workspace_client_id FROM mcp_workspace_clients WHERE mcp_client_id = $clientId AND tenant_id = $tenantId',
        )
        .get({ clientId, tenantId })?.workspace_client_id ?? null
    );
  }

  setWorkspaceClient(clientId: string, tenantId: string, workspaceClientId: string): void {
    this.db
      .query(
        `INSERT INTO mcp_workspace_clients (mcp_client_id, tenant_id, workspace_client_id) VALUES ($clientId, $tenantId, $workspaceClientId)
         ON CONFLICT (mcp_client_id, tenant_id) DO UPDATE SET workspace_client_id = excluded.workspace_client_id`,
      )
      .run({ clientId, tenantId, workspaceClientId });
  }

  createRequest(input: Omit<PendingRequest, 'id' | 'tenantId' | 'verifier'>): PendingRequest {
    const now = Date.now();
    this.db.query('DELETE FROM mcp_requests WHERE expires_at <= $now').run({ now });
    const request: PendingRequest = { ...input, id: randomToken(16), tenantId: null, verifier: null };
    this.db
      .query(
        `INSERT INTO mcp_requests (id, account_id, client_id, redirect_uri, state, code_challenge, expires_at)
         VALUES ($id, $accountId, $clientId, $redirectUri, $state, $codeChallenge, $expiresAt)`,
      )
      .run({ id: request.id, accountId: request.accountId, clientId: request.clientId, redirectUri: request.redirectUri, state: request.state, codeChallenge: request.codeChallenge, expiresAt: now + REQUEST_TTL });
    return request;
  }

  findRequest(id: string): PendingRequest | null {
    const row = this.db
      .query<
        { id: string; account_id: string; client_id: string; redirect_uri: string; state: string | null; code_challenge: string; tenant_id: string | null; verifier: string | null },
        { id: string; now: number }
      >('SELECT * FROM mcp_requests WHERE id = $id AND expires_at > $now')
      .get({ id, now: Date.now() });
    return (
      row && {
        id: row.id,
        accountId: row.account_id,
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        state: row.state,
        codeChallenge: row.code_challenge,
        tenantId: row.tenant_id,
        verifier: row.verifier,
      }
    );
  }

  chooseWorkspace(id: string, tenantId: string, verifier: string): void {
    this.db.query('UPDATE mcp_requests SET tenant_id = $tenantId, verifier = $verifier WHERE id = $id').run({ id, tenantId, verifier });
  }

  deleteRequest(id: string): void {
    this.db.query('DELETE FROM mcp_requests WHERE id = $id').run({ id });
  }

  /** A code for the agent. The workspace's tokens wait sealed with the code, so control.db alone can't open them. */
  createCode(request: PendingRequest, tenantId: string, tokens: IssuedTokens): string {
    const code = randomToken();
    const now = Date.now();
    this.db.query('DELETE FROM mcp_codes WHERE expires_at <= $now').run({ now });
    this.db
      .query(
        `INSERT INTO mcp_codes (code_hash, client_id, redirect_uri, code_challenge, tenant_id, sealed, expires_at)
         VALUES ($hash, $clientId, $redirectUri, $codeChallenge, $tenantId, $sealed, $expiresAt)`,
      )
      .run({
        hash: hashToken(code),
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        tenantId,
        sealed: sealWithToken(code, JSON.stringify(tokens)),
        expiresAt: now + CODE_TTL,
      });
    return code;
  }

  takeCode(code: string): { clientId: string; redirectUri: string; codeChallenge: string; tenantId: string; tokens: IssuedTokens } | null {
    const row = this.db
      .query<{ client_id: string; redirect_uri: string; code_challenge: string; tenant_id: string; sealed: string }, { hash: string; now: number }>(
        'DELETE FROM mcp_codes WHERE code_hash = $hash AND expires_at > $now RETURNING client_id, redirect_uri, code_challenge, tenant_id, sealed',
      )
      .get({ hash: hashToken(code), now: Date.now() });
    const opened = row && openWithToken(code, row.sealed);
    if (!row || !opened) return null;
    return { clientId: row.client_id, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge, tenantId: row.tenant_id, tokens: JSON.parse(opened) as IssuedTokens };
  }
}

const oauthError = (c: Context, error: string, description: string, status: 400 | 401 | 429 = 400) =>
  c.json({ error, error_description: description }, status, { 'cache-control': 'no-store' });

/** mcp.<domain>: the shared MCP endpoint and its protected-resource metadata. */
export function mcpResource(cloud: Cloud): Hono {
  const app = new Hono();
  const resource = `${cloud.mcpUrl()}/mcp`;
  const metadataUrl = `${cloud.mcpUrl()}/.well-known/oauth-protected-resource/mcp`;
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="${SCOPE}"`;
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-session-id'], exposeHeaders: ['www-authenticate'] }));

  const metadata = (c: Context) =>
    c.json({
      resource,
      authorization_servers: [cloud.controlUrl()],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'OpenParley',
      resource_documentation: 'https://openparley.dev/docs#agents',
    });
  app.get('/.well-known/oauth-protected-resource', metadata);
  app.get('/.well-known/oauth-protected-resource/mcp', metadata);
  app.get('/health', (c) => c.json({ ok: true }));

  app.all('/mcp', async (c) => {
    const bearer = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    const dot = bearer.indexOf('.');
    const tenant = dot > 0 ? cloud.control.findById(bearer.slice(0, dot)) : null;
    if (!tenant) return c.json({ error: 'invalid_token', error_description: 'Sign in again.' }, 401, { 'www-authenticate': `${challenge}, error="invalid_token"` });
    const headers = new Headers(c.req.raw.headers);
    headers.delete('host');
    headers.set('authorization', `Bearer ${bearer.slice(dot + 1)}`);
    const method = c.req.method;
    const forwarded = await cloud.fetch(
      new Request(`${cloud.workspaceUrl(tenant.slug)}/mcp`, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer() }),
    );
    // The workspace points agents at its own URL to sign in; on this URL, sign-in runs through Cloud.
    if (forwarded.status !== 401) return forwarded;
    const out = new Headers(forwarded.headers);
    out.set('www-authenticate', `${challenge}, error="invalid_token"`);
    return new Response(forwarded.body, { status: 401, headers: out });
  });
  return app;
}

/**
 * The control plane as the shared URL's authorization server. `api` routes are called by agents
 * (no cookies, outside the CSRF check); `browser` routes are where people pick a workspace.
 */
export function brokerRoutes(cloud: Cloud) {
  const store = cloud.broker;
  const issuer = cloud.controlUrl();
  const resource = `${cloud.mcpUrl()}/mcp`;
  const callback = `${issuer}/oauth/workspace-callback`;
  const registrations = new RateLimiter(30, 60 * 60 * 1000);

  const api = (app: Hono<AccountEnv>, clientIp: (c: Context) => string) => {
    const open = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version'] });
    for (const path of ['/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token', '/oauth/revoke']) {
      app.use(path, open, bodyLimit({ maxSize: 64 * 1024, onError: (c) => oauthError(c, 'invalid_request', 'Request too large.') }));
    }

    app.get('/.well-known/oauth-authorization-server', (c) =>
      c.json({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        scopes_supported: [SCOPE],
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        authorization_response_iss_parameter_supported: true,
        service_documentation: 'https://openparley.dev/docs#agents',
      }),
    );

    app.post('/oauth/register', async (c) => {
      const ip = clientIp(c);
      if (registrations.blocked(ip)) return oauthError(c, 'invalid_request', 'Too many registrations from this address. Try again later.', 429);
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return oauthError(c, 'invalid_client_metadata', 'Send the client metadata as a JSON object.');
      const uris = body.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string')) {
        return oauthError(c, 'invalid_redirect_uri', 'Give 1 to 10 redirect_uris.');
      }
      for (const uri of uris as string[]) {
        const problem = redirectUriProblem(uri);
        if (problem) return oauthError(c, 'invalid_redirect_uri', `${uri.slice(0, 100)}: ${problem}`);
      }
      const method = body.token_endpoint_auth_method ?? 'none';
      if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic') {
        return oauthError(c, 'invalid_client_metadata', 'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.');
      }
      registrations.fail(ip);
      const name = typeof body.client_name === 'string' ? body.client_name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || 'MCP client' : 'MCP client';
      const { client, secret } = store.registerClient(name, uris as string[], method !== 'none');
      return c.json(
        {
          client_id: client.id,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
          client_name: client.name,
          redirect_uris: client.redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: method,
          scope: SCOPE,
        },
        201,
        { 'cache-control': 'no-store' },
      );
    });

    app.post('/oauth/token', async (c) => {
      const form = await fields(c);
      const client = authenticate(c, form);
      if (!client) return oauthError(c, 'invalid_client', 'Unknown client or wrong client credentials. Register again.', 401);
      if (form.grant_type === 'authorization_code') {
        const grant = form.code ? store.takeCode(form.code) : null;
        if (!grant || !form.code_verifier || grant.clientId !== client.id || pkceChallenge(form.code_verifier) !== grant.codeChallenge || (form.redirect_uri ?? grant.redirectUri) !== grant.redirectUri) {
          return oauthError(c, 'invalid_grant', 'The code is invalid, expired or already used. Sign in again.');
        }
        return tokenResponse(c, grant.tenantId, grant.tokens);
      }
      if (form.grant_type === 'refresh_token') {
        const [tenantId, inner] = split(form.refresh_token);
        const tenant = tenantId ? cloud.control.findById(tenantId) : null;
        const workspaceClient = tenant ? store.workspaceClient(client.id, tenant.id) : null;
        if (!tenant || !inner || !workspaceClient) return oauthError(c, 'invalid_grant', 'This sign-in was revoked or has expired. Sign in again.');
        const res = await workspacePost(tenant, '/oauth/token', { grant_type: 'refresh_token', refresh_token: inner, client_id: workspaceClient });
        if (!res.ok) return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
        return tokenResponse(c, tenant.id, (await res.json()) as IssuedTokens);
      }
      return oauthError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    });

    app.post('/oauth/revoke', async (c) => {
      const form = await fields(c);
      const client = authenticate(c, form);
      if (!client) return oauthError(c, 'invalid_client', 'Unknown client or wrong client credentials.', 401);
      const [tenantId, inner] = split(form.token);
      const tenant = tenantId ? cloud.control.findById(tenantId) : null;
      const workspaceClient = tenant ? store.workspaceClient(client.id, tenant.id) : null;
      if (tenant && inner && workspaceClient) await workspacePost(tenant, '/oauth/revoke', { token: inner, client_id: workspaceClient });
      return c.body(null, 200);
    });
  };

  const browser = (app: Hono<AccountEnv>, siteUrl: string | null) => {
    app.get('/oauth/authorize', (c) => {
      const params = new URLSearchParams(c.req.query());
      const parsed = parseAuthorize(params);
      if ('page' in parsed) return c.html(<Message title="Can't connect this agent">{parsed.page}</Message>, 400);
      if ('error' in parsed) return c.redirect(parsed.error, 302);
      const account = c.get('account');
      const here = `/oauth/authorize?${params}`;
      if (!account) return c.redirect(`/login?${new URLSearchParams({ next: here })}`, 302);
      const workspaces = cloud.accounts
        .memberships(account)
        .map((m) => cloud.control.findById(m.tenantId))
        .filter((t): t is Tenant => !!t && t.status === 'active');
      const request = store.createRequest({ accountId: account.id, clientId: parsed.client.id, redirectUri: parsed.redirectUri, state: parsed.state, codeChallenge: parsed.codeChallenge });
      // One workspace: nothing to ask.
      if (workspaces.length === 1) return toWorkspace(c, request, workspaces[0]!, parsed.client);
      return c.html(<PickerPage request={request} client={parsed.client} workspaces={workspaces} next={here} cloud={cloud} siteUrl={siteUrl} account={account} />);
    });

    app.post('/oauth/authorize', async (c) => {
      const form = await c.req.parseBody();
      const account = c.get('account');
      const request = store.findRequest(String(form.request ?? ''));
      if (!account || !request || request.accountId !== account.id) return c.html(<Expired />, 400);
      const tenant = cloud.control.findById(String(form.workspace ?? ''));
      const member = tenant && cloud.accounts.memberships(account).some((m) => m.tenantId === tenant.id);
      const client = store.findClient(request.clientId);
      if (!tenant || !member || tenant.status !== 'active' || !client) return c.html(<Expired />, 400);
      return toWorkspace(c, request, tenant, client);
    });

    // Back from the workspace's consent page.
    app.get('/oauth/workspace-callback', async (c) => {
      const account = c.get('account');
      const request = store.findRequest(c.req.query('state') ?? '');
      if (!account || !request || request.accountId !== account.id || !request.tenantId || !request.verifier) return c.html(<Expired />, 400);
      store.deleteRequest(request.id);
      const back = (params: Record<string, string>) => {
        const url = new URL(request.redirectUri);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        if (request.state !== null) url.searchParams.set('state', request.state);
        url.searchParams.set('iss', issuer);
        return c.redirect(url.href, 302);
      };
      const error = c.req.query('error');
      if (error) return back({ error, ...(c.req.query('error_description') && { error_description: c.req.query('error_description')! }) });
      const tenant = cloud.control.findById(request.tenantId);
      const workspaceClient = tenant && store.workspaceClient(request.clientId, tenant.id);
      if (!tenant || !workspaceClient || !c.req.query('code')) return c.html(<Expired />, 400);
      const res = await workspacePost(tenant, '/oauth/token', {
        grant_type: 'authorization_code',
        code: c.req.query('code')!,
        code_verifier: request.verifier,
        client_id: workspaceClient,
        redirect_uri: callback,
      });
      if (!res.ok) return back({ error: 'server_error', error_description: 'The workspace did not issue tokens. Try again.' });
      return back({ code: store.createCode(request, tenant.id, (await res.json()) as IssuedTokens) });
    });
  };

  /** Registers Cloud with the workspace (once per agent), then signs you in there, landing on its consent page. */
  function toWorkspace(c: Context, request: PendingRequest, tenant: Tenant, client: McpClient) {
    const account = cloud.accounts.find(request.accountId)!;
    const repo = cloud.workspaceRepo(tenant);
    let workspaceClient = store.workspaceClient(client.id, tenant.id);
    // Workspaces drop registrations that never signed in after a while; register again then.
    if (!workspaceClient || !repo.findOAuthClient(workspaceClient)) {
      workspaceClient = repo.registerOAuthClient({ name: client.name, redirectUris: [callback], confidential: false }).client.id;
      store.setWorkspaceClient(client.id, tenant.id, workspaceClient);
    }
    const verifier = randomToken(48);
    store.chooseWorkspace(request.id, tenant.id, verifier);
    const consent = `/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: workspaceClient,
      redirect_uri: callback,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state: request.id,
      resource: `${cloud.workspaceUrl(tenant.slug)}/mcp`,
      scope: SCOPE,
    })}`;
    return c.redirect(cloud.handoffUrl(tenant, account, consent), 302);
  }

  function parseAuthorize(params: URLSearchParams):
    | { client: McpClient; redirectUri: string; state: string | null; codeChallenge: string }
    | { page: string }
    | { error: string } {
    const client = store.findClient(params.get('client_id') ?? '');
    if (!client) return { page: "This sign-in link is for an app OpenParley doesn't know (anymore). Start connecting again from your agent." };
    const asked = params.get('redirect_uri');
    const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
    if (!redirectUri || !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
      return { page: "This sign-in link sends you somewhere its app didn't register. Start connecting again from your agent." };
    }
    const state = params.get('state');
    const fail = (error: string, description: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set('error', error);
      url.searchParams.set('error_description', description);
      if (state !== null) url.searchParams.set('state', state);
      url.searchParams.set('iss', issuer);
      return { error: url.href };
    };
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    const challenge = params.get('code_challenge') ?? '';
    if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    const asking = params.get('resource')?.replace(/\/+$/, '');
    if (asking && asking !== resource && asking !== cloud.mcpUrl()) return fail('invalid_target', `This server only issues tokens for ${resource}.`);
    return { client, redirectUri, state, codeChallenge: challenge };
  }

  function authenticate(c: Context, form: Record<string, string | undefined>): McpClient | null {
    let id = form.client_id;
    let secret = form.client_secret;
    const header = c.req.header('authorization');
    if (header?.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString();
      const colon = decoded.indexOf(':');
      if (colon < 0) return null;
      id = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }
    const client = id ? store.findClient(id) : null;
    if (!client) return null;
    if (client.secretHash === null) return client;
    return secret && hashToken(secret) === client.secretHash ? client : null;
  }

  /** Calls one of the workspace's OAuth endpoints, through the router (so a paused workspace stays paused). */
  function workspacePost(tenant: Tenant, path: string, body: Record<string, string>) {
    return cloud.fetch(
      new Request(`${cloud.workspaceUrl(tenant.slug)}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }),
    );
  }

  return { api, browser };
}

function tokenResponse(c: Context, tenantId: string, tokens: IssuedTokens) {
  return c.json(
    {
      access_token: `${tenantId}.${tokens.access_token}`,
      token_type: 'Bearer',
      ...(tokens.expires_in !== undefined && { expires_in: tokens.expires_in }),
      ...(tokens.refresh_token && { refresh_token: `${tenantId}.${tokens.refresh_token}` }),
      scope: SCOPE,
    },
    200,
    { 'cache-control': 'no-store', pragma: 'no-cache' },
  );
}

/** `<workspace id>.<the workspace's own token>` */
function split(token: string | undefined): [string | null, string | null] {
  const dot = token?.indexOf('.') ?? -1;
  return dot > 0 ? [token!.slice(0, dot), token!.slice(dot + 1)] : [null, null];
}

async function fields(c: Context): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  try {
    for (const [key, value] of Object.entries(await c.req.parseBody())) if (typeof value === 'string') out[key] = value;
  } catch {}
  return out;
}

function Expired() {
  return <Message title="Sign-in expired">This connection took too long or was already used. Start connecting again from your agent.</Message>;
}

function PickerPage(props: {
  request: PendingRequest;
  client: McpClient;
  workspaces: Tenant[];
  next: string;
  cloud: Cloud;
  siteUrl: string | null;
  account: NonNullable<AccountEnv['Variables']['account']>;
}) {
  const { request, client, workspaces, next, cloud, siteUrl, account } = props;
  const title = `Connect ${client.name} to OpenParley`;
  return (
    <Page title={title} siteUrl={siteUrl} aside={<AccountAside account={account} />}>
      <h1>{title}</h1>
      {workspaces.length === 0 ? (
        <>
          <p>
            {account.githubLogin ?? account.email} isn't in any workspace yet. Start one (free, ready right away) and {client.name} connects to it.
          </p>
          <a class="button" href={`/signup?${new URLSearchParams({ plan: 'free', next })}`}>
            Create a workspace
          </a>
          <p class="muted">
            Already in a workspace with another address? Confirm that address on its admin page, or sign out and sign in with that account.
          </p>
        </>
      ) : (
        <>
          <p>Which workspace should it work in?</p>
          <form method="post" action="/oauth/authorize" class="box">
            <input type="hidden" name="request" value={request.id} />
            {workspaces.map((tenant, i) => (
              <label class="choice">
                <input type="radio" name="workspace" value={tenant.id} checked={i === 0} required /> <strong>{tenant.name}</strong>{' '}
                <span class="muted">{new URL(cloud.workspaceUrl(tenant.slug)).host}</span>
              </label>
            ))}
            <button type="submit">Continue</button>
          </form>
          <p class="muted">
            <a href={`/signup?${new URLSearchParams({ plan: 'free', next })}`}>Create a workspace</a> instead.
          </p>
        </>
      )}
    </Page>
  );
}
