/** @jsxImportSource hono/jsx */
import { LIMITS } from '@openparley/protocol';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { Config } from './config';
import { hashToken } from './crypto';
import { RateLimiter } from './rate-limit';
import type { OAuthClient, OAuthTokens, Repo } from './repo';
import { agentNameSchema } from './validation';
import { ErrorBox, Page, type WebEnv } from './web';

// OAuth 2.1 as the MCP authorization spec asks for: this server is both the resource server (/mcp)
// and its own authorization server. Clients register themselves (RFC 7591), use PKCE with S256, and
// what a user approves becomes an agent on the admin page, revocable like a pasted token.

export const SCOPE = 'threads';
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;

export interface OAuthUrls {
  issuer: string;
  resource: string;
  resourceMetadata: string;
}

export function oauthUrls(config: Config): OAuthUrls {
  return {
    issuer: config.publicUrl,
    resource: `${config.publicUrl}/mcp`,
    resourceMetadata: `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`,
  };
}

/** Discovery, registration, token and revocation endpoints: called by agents, never with cookies. */
export function oauthRoutes({ repo, config, clientIp }: { repo: Repo; config: Config; clientIp: (c: Context) => string }): Hono {
  const oauth = new Hono();
  const urls = oauthUrls(config);
  const registrations = new RateLimiter(30, 60 * 60 * 1000);
  // Browser-based MCP clients (e.g. the MCP Inspector) call these with fetch. None of them use cookies.
  const open = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version'] });
  for (const path of ['/.well-known/*', '/oauth/register', '/oauth/token', '/oauth/revoke']) {
    oauth.use(path, open, bodyLimit({ maxSize: 64 * 1024, onError: (c) => oauthError(c, 'invalid_request', 'Request too large.') }));
  }

  const resourceMetadata = (c: Context) =>
    c.json({
      resource: urls.resource,
      authorization_servers: [urls.issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'OpenParley',
      resource_documentation: 'https://openparley.dev/docs#agents',
    });
  oauth.get('/.well-known/oauth-protected-resource', resourceMetadata);
  oauth.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);

  oauth.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer: urls.issuer,
      authorization_endpoint: `${urls.issuer}/oauth/authorize`,
      token_endpoint: `${urls.issuer}/oauth/token`,
      registration_endpoint: `${urls.issuer}/oauth/register`,
      revocation_endpoint: `${urls.issuer}/oauth/revoke`,
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

  oauth.post('/oauth/register', async (c) => {
    const ip = clientIp(c);
    if (registrations.blocked(ip)) return oauthError(c, 'invalid_request', 'Too many registrations from this address. Try again later.', 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return oauthError(c, 'invalid_client_metadata', 'Send the client metadata as JSON.');
    }
    if (!isRecord(body)) return oauthError(c, 'invalid_client_metadata', 'Send the client metadata as a JSON object.');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every((uri) => typeof uri === 'string')) {
      return oauthError(c, 'invalid_redirect_uri', `Give 1 to ${MAX_REDIRECT_URIS} redirect_uris.`);
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
    const name = cleanName(body.client_name) || 'MCP client';
    const { client, secret } = repo.registerOAuthClient({ name, redirectUris: uris as string[], confidential: method !== 'none' });
    return c.json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
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

  oauth.post('/oauth/token', async (c) => {
    const form = await formFields(c);
    const client = authenticateClient(c, repo, form);
    if (!client) return oauthError(c, 'invalid_client', 'Unknown client or wrong client credentials. Register again.', 401);
    let tokens: OAuthTokens | null;
    switch (form.grant_type) {
      case 'authorization_code': {
        const { code, redirect_uri: redirectUri, code_verifier: verifier } = form;
        if (!code || !verifier) return oauthError(c, 'invalid_request', 'code and code_verifier are required.');
        if (form.resource && !resourceMatches(form.resource, urls)) return oauthError(c, 'invalid_target', `This server only issues tokens for ${urls.resource}.`);
        const grant = repo.takeOAuthCode(code);
        if (!grant || grant.clientId !== client.id || (redirectUri ?? grant.redirectUri) !== grant.redirectUri || pkceChallenge(verifier) !== grant.codeChallenge) {
          return oauthError(c, 'invalid_grant', 'The code is invalid, expired or already used. Sign in again.');
        }
        tokens = repo.createOAuthAgent(grant.userId, client.id, grant.agentName);
        break;
      }
      case 'refresh_token': {
        if (!form.refresh_token) return oauthError(c, 'invalid_request', 'refresh_token is required.');
        tokens = repo.refreshOAuthAgent(form.refresh_token, client.id);
        break;
      }
      default:
        return oauthError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }
    if (!tokens) return oauthError(c, 'invalid_grant', 'This sign-in was revoked or has expired. Sign in again.');
    return c.json(
      { access_token: tokens.accessToken, token_type: 'Bearer', expires_in: tokens.expiresIn, refresh_token: tokens.refreshToken, scope: SCOPE },
      200,
      { 'cache-control': 'no-store', pragma: 'no-cache' },
    );
  });

  oauth.post('/oauth/revoke', async (c) => {
    const form = await formFields(c);
    const client = authenticateClient(c, repo, form);
    if (!client) return oauthError(c, 'invalid_client', 'Unknown client or wrong client credentials.', 401);
    if (form.token) repo.revokeOAuthToken(form.token, client.id);
    return c.body(null, 200);
  });

  return oauth;
}

/** `/oauth/authorize`: the signed-in user approves an agent. Mounted inside the web routes for their session, CSRF and CSP. */
export function authorizeRoutes({ repo, config }: { repo: Repo; config: Config }): Hono<WebEnv> {
  const authorize = new Hono<WebEnv>();
  const urls = oauthUrls(config);
  const workspace = new URL(config.publicUrl).host;

  authorize.get('/', (c) => {
    const request = parseAuthorizeRequest(repo, urls, new URLSearchParams(c.req.query()));
    if ('page' in request) return c.html(<AuthorizeErrorPage message={request.page} />, 400);
    if ('error' in request) return continueTo(c, request.error);
    const here = new URL(c.req.url);
    if (!c.get('user')) return c.redirect(`/login?next=${encodeURIComponent(here.pathname + here.search)}`);
    return c.html(<ConsentPage request={request} workspace={workspace} userName={c.get('user')!.name} />);
  });

  authorize.post('/', async (c) => {
    const form = await c.req.parseBody();
    const fields = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) if (typeof value === 'string') fields.set(key, value);
    const request = parseAuthorizeRequest(repo, urls, fields);
    if ('page' in request) return c.html(<AuthorizeErrorPage message={request.page} />, 400);
    if ('error' in request) return continueTo(c, request.error);
    const user = c.get('user');
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${fields}`)}`);
    if (fields.get('decision') !== 'approve') return continueTo(c, redirectWithParams(request, { error: 'access_denied', error_description: 'The user declined.' }, urls));
    const name = agentNameSchema.safeParse(fields.get('name'));
    if (!name.success) return c.html(<ConsentPage request={request} workspace={workspace} userName={user.name} error={name.error.issues[0]!.message} />, 400);
    const code = repo.createOAuthCode({
      clientId: request.client.id,
      userId: user.id,
      agentName: name.data,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
    });
    return continueTo(c, redirectWithParams(request, { code }, urls));
  });

  return authorize;
}

interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string | null;
  scope: string | null;
}

/**
 * Errors about the client or redirect URI are shown on our own page: sending them to an unverified
 * redirect URI would make this server an open redirector. Everything else goes back to the client.
 */
function parseAuthorizeRequest(repo: Repo, urls: OAuthUrls, params: URLSearchParams): AuthorizeRequest | { page: string } | { error: string } {
  const client = repo.findOAuthClient(params.get('client_id') ?? '');
  if (!client) return { page: "This sign-in link is for an app this workspace doesn't know (anymore). Start connecting again from your agent." };
  const asked = params.get('redirect_uri');
  const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
  if (!redirectUri || !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
    return { page: "This sign-in link sends you somewhere its app didn't register. Start connecting again from your agent." };
  }
  const request = { client, redirectUri, state: params.get('state'), resource: params.get('resource'), scope: params.get('scope'), codeChallenge: '' };
  const fail = (error: string, description: string) => ({ error: redirectWithParams(request, { error, error_description: description }, urls) });
  if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
  const challenge = params.get('code_challenge') ?? '';
  if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  }
  if (request.resource && !resourceMatches(request.resource, urls)) return fail('invalid_target', `This server only issues tokens for ${urls.resource}.`);
  return { ...request, codeChallenge: challenge };
}

function redirectWithParams(request: Pick<AuthorizeRequest, 'redirectUri' | 'state'>, params: Record<string, string>, urls: OAuthUrls): string {
  const url = new URL(request.redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (request.state !== null) url.searchParams.set('state', request.state);
  url.searchParams.set('iss', urls.issuer);
  return url.href;
}

/**
 * Hands the browser to the agent's redirect URI with a page instead of a 302: browsers apply the
 * page's `form-action 'self'` CSP to redirects after a form post, which would block a 302 to
 * localhost or an app's own URL scheme.
 */
function continueTo(c: Context<WebEnv>, url: string) {
  return c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="refresh" content={`0;url=${url}`} />
        <title>Returning to your agent · OpenParley</title>
      </head>
      <body style="font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;color:#14181f;background:#fbf7ee">
        <p>
          Returning to your agent… If nothing happens, <a href={url}>continue</a>.
        </p>
        <p style="color:#5e6672">You can close this window afterwards.</p>
      </body>
    </html>,
  );
}

/** Where the browser goes after approving, in words a person can check against what they just did. */
function destination(uri: string): string {
  const url = new URL(uri);
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return isLoopback(url.hostname) ? `an app on this computer (${url.host})` : url.host;
  }
  return `the app that opens ${url.protocol}// links`;
}

function ConsentPage({ request, workspace, userName, error }: { request: AuthorizeRequest; workspace: string; userName: string; error?: string }) {
  const defaultName = request.client.name.slice(0, LIMITS.agentName);
  return (
    <Page title="Connect an agent?">
      <h1>Connect an agent?</h1>
      <ErrorBox error={error} />
      <p>
        <strong>{request.client.name}</strong> wants to work with the threads in <strong>{workspace}</strong> as an agent for you ({userName}): read
        threads, reply to them, and resolve or reopen them. It can't start or delete threads, or change anything else in the workspace.
      </p>
      <p class="muted">
        After you approve, you go back to <strong>{destination(request.redirectUri)}</strong>. Only approve if you just started connecting this agent
        yourself.
      </p>
      <form method="post" action="/oauth/authorize">
        {(
          [
            ['response_type', 'code'],
            ['client_id', request.client.id],
            ['redirect_uri', request.redirectUri],
            ['code_challenge', request.codeChallenge],
            ['code_challenge_method', 'S256'],
            ['state', request.state],
            ['resource', request.resource],
            ['scope', request.scope],
          ] as const
        ).map(([name, value]) => value !== null && <input type="hidden" name={name} value={value} />)}
        <label for="agent-name">Agent name</label>
        <input id="agent-name" name="name" required maxlength={LIMITS.agentName} value={defaultName} />
        <p class="muted" style="margin:4px 0 0">Shown on its replies, and on the admin page where you can disconnect it.</p>
        <div class="row" style="margin-top:12px">
          <button type="submit" name="decision" value="approve">
            Approve
          </button>
          <button type="submit" name="decision" value="deny" class="secondary" formnovalidate>
            Cancel
          </button>
        </div>
      </form>
    </Page>
  );
}

function AuthorizeErrorPage({ message }: { message: string }) {
  return (
    <Page title="Can't connect this agent">
      <h1>Can't connect this agent</h1>
      <p>{message}</p>
    </Page>
  );
}

// --- helpers -----------------------------------------------------------------

export function pkceChallenge(verifier: string): string {
  return new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
}

const isLoopback = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

/** https anywhere, http only on this computer, or an app's own scheme (e.g. cursor://), per RFC 8252. */
export function redirectUriProblem(uri: string): string | null {
  if (uri.length > MAX_URI_LENGTH) return 'too long';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'not a URL';
  }
  if (url.hash || uri.includes('#')) return 'must not have a fragment';
  if (url.username || url.password) return 'must not contain credentials';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') return isLoopback(url.hostname) ? null : 'http is only allowed for localhost';
  if (['javascript:', 'data:', 'file:', 'blob:', 'vbscript:', 'about:', 'ws:', 'wss:', 'ftp:', 'mailto:'].includes(url.protocol)) return 'scheme not allowed';
  return null;
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 7.3): native apps pick a free one each time. */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    return a.protocol === 'http:' && b.protocol === 'http:' && isLoopback(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

function resourceMatches(resource: string, urls: OAuthUrls): boolean {
  const trimmed = resource.replace(/\/+$/, '');
  return trimmed === urls.resource || trimmed === urls.issuer;
}

async function formFields(c: Context): Promise<Record<string, string | undefined>> {
  const fields: Record<string, string | undefined> = {};
  try {
    const body = await c.req.parseBody();
    for (const [key, value] of Object.entries(body)) if (typeof value === 'string') fields[key] = value;
  } catch {
    // An unreadable body is handled like an empty one: every grant then fails with a clear error.
  }
  return fields;
}

/** Public clients name themselves with client_id; confidential ones also prove the secret (Basic or in the body). */
function authenticateClient(c: Context, repo: Repo, form: Record<string, string | undefined>): OAuthClient | null {
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
  const client = id ? repo.findOAuthClient(id) : null;
  if (!client) return null;
  if (client.secretHash === null) return client;
  return secret && hashToken(secret) === client.secretHash ? client : null;
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '';
}

function oauthError(c: Context, error: string, description: string, status: 400 | 401 | 429 = 400) {
  return c.json({ error, error_description: description }, status, { 'cache-control': 'no-store' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
