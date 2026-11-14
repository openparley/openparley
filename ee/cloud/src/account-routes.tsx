/** @jsxImportSource hono/jsx */
import { emailSchema, githubAuthorizeUrl, githubIdentity, randomToken, RateLimiter } from '@openparley/sync';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { ACCOUNT_SESSION_TTL, type Account } from './accounts';
import type { Cloud } from './cloud';
import type { CloudConfig } from './config';
import { isPlanId, PLANS } from './plans';
import { Message, Page } from './views';

export const ACCOUNT_COOKIE = 'openparley_account';
const GITHUB_STATE = 'openparley_github';

export type AccountEnv = { Variables: { nonce: string; account: Account | null } };

/** Only paths on the control plane, so `next` can't send people elsewhere. */
export function safeNext(next: string | undefined | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

/**
 * Cloud accounts on cloud.<domain>: sign in with GitHub or an emailed link, see your workspaces, open
 * one (a signed hand-off: the workspace decides who you are there). Workspaces also start GitHub
 * sign-in here (`/auth/github?workspace=<id>`), because GitHub can't call back to every subdomain.
 */
export function accountRoutes(app: Hono<AccountEnv>, { cloud, config, base, clientIp }: { cloud: Cloud; config: CloudConfig; base: string; clientIp: (c: Context) => string }) {
  const secure = config.scheme === 'https';
  const linkPerIp = new RateLimiter(10, 60 * 60 * 1000);
  const linkPerEmail = new RateLimiter(3, 60 * 60 * 1000);

  app.use('*', async (c, next) => {
    const token = getCookie(c, ACCOUNT_COOKIE);
    c.set('account', token ? cloud.accounts.accountForSession(token) : null);
    await next();
  });

  const signIn = (c: Context, account: Account) => {
    setCookie(c, ACCOUNT_COOKIE, cloud.accounts.createSession(account.id), { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: ACCOUNT_SESSION_TTL / 1000 });
  };

  /** After signing in: into a workspace (hand-off) or on to a page here. */
  const proceed = (c: Context, account: Account, next: string, workspaceId: string | null) => {
    const tenant = workspaceId ? cloud.control.findById(workspaceId) : null;
    if (tenant && tenant.status === 'active') return c.redirect(cloud.handoffUrl(tenant, account, next.startsWith('/') ? next : '/admin'), 302);
    return c.redirect(safeNext(next), 302);
  };

  app.get('/login', (c) => {
    const next = safeNext(c.req.query('next'));
    const account = c.get('account');
    if (account) return c.redirect(next);
    return c.html(<LoginPage github={!!config.github} next={next} siteUrl={config.siteUrl} />);
  });

  // --- GitHub ------------------------------------------------------------------

  app.get('/auth/github', (c) => {
    const workspace = c.req.query('workspace') ?? '';
    // A workspace passes its own path as `next`; anything else stays on the control plane.
    const next = workspace ? (c.req.query('next') ?? '/admin') : safeNext(c.req.query('next'));
    const account = c.get('account');
    // Already signed in with GitHub here: nothing to ask GitHub again.
    if (account?.githubId && workspace) return proceed(c, account, next, workspace);
    if (!config.github) return c.html(<Message title="GitHub sign-in is off">This server has no GitHub sign-in. Use your email instead.</Message>, 404);
    const state = randomToken(16);
    setCookie(c, GITHUB_STATE, JSON.stringify({ state, next, workspace }), { httpOnly: true, secure, sameSite: 'Lax', path: '/auth/github', maxAge: 600 });
    return c.redirect(githubAuthorizeUrl(config.github, `${base}/auth/github/callback`, state));
  });

  app.get('/auth/github/callback', async (c) => {
    if (!config.github) return c.notFound();
    let saved: { state?: string; next?: string; workspace?: string } = {};
    try {
      saved = JSON.parse(getCookie(c, GITHUB_STATE) ?? '{}');
    } catch {}
    deleteCookie(c, GITHUB_STATE, { path: '/auth/github' });
    const code = c.req.query('code');
    if (!saved.state || !code || c.req.query('state') !== saved.state) {
      return c.html(<Message title="Sign-in expired">That GitHub sign-in didn't start in this browser, or took too long. Try again.</Message>, 400);
    }
    let identity;
    try {
      identity = await githubIdentity(config.github, code, `${base}/auth/github/callback`);
    } catch (error) {
      console.error('GitHub sign-in failed:', error);
      return c.html(<Message title="GitHub sign-in failed">GitHub didn't confirm who you are. Try again in a moment.</Message>, 502);
    }
    if (!identity.emailVerified) {
      return c.html(<Message title="Verify an email on GitHub first">Your GitHub account has no verified email address. Verify one in GitHub's settings, then try again.</Message>, 400);
    }
    const account = cloud.accounts.fromGithub(identity);
    if (!account) {
      return c.html(
        <Message title="Email already in use">{identity.email} belongs to an OpenParley account with another GitHub account. Sign in with that one, or with an emailed link.</Message>,
        409,
      );
    }
    signIn(c, account);
    return proceed(c, account, saved.next ?? '/', saved.workspace || null);
  });

  // --- emailed sign-in links ---------------------------------------------------

  app.post('/login/email', async (c) => {
    const form = await c.req.parseBody();
    const next = safeNext(String(form.next ?? ''));
    const email = emailSchema.safeParse(String(form.email ?? '').trim());
    if (!email.success) return c.html(<LoginPage github={!!config.github} next={next} siteUrl={config.siteUrl} error={email.error.issues[0]!.message} />, 400);
    const ip = clientIp(c);
    const address = email.data.toLowerCase();
    if (linkPerIp.blocked(ip) || linkPerEmail.blocked(address)) {
      return c.html(<LoginPage github={!!config.github} next={next} siteUrl={config.siteUrl} error="Too many sign-in links. Try again in an hour." />, 429);
    }
    linkPerIp.fail(ip);
    linkPerEmail.fail(address);
    const link = `${base}/login/link?token=${cloud.accounts.createSignInLink(address, next)}`;
    try {
      await cloud.mail({
        to: address,
        subject: 'Sign in to OpenParley',
        text: ['To sign in to OpenParley, open:', link, '', "The link works once, for 30 minutes. If you didn't ask for it, ignore this email."].join('\n'),
      });
    } catch (error) {
      console.error('Sending a sign-in link failed:', error);
      return c.html(<LoginPage github={!!config.github} next={next} siteUrl={config.siteUrl} error="We couldn't send the email. Try again in a minute." />, 502);
    }
    // The same answer whether or not an account exists: the link creates one when it's used.
    return c.html(<Message title="Check your email">We've sent a sign-in link to {address}. It works once, for 30 minutes.</Message>);
  });

  // Opening the link changes nothing (mail scanners prefetch links); the button signs in.
  app.get('/login/link', (c) =>
    c.html(
      <Page title="Sign in">
        <h1>Sign in to OpenParley</h1>
        <form method="post" action="/login/link" class="box">
          <input type="hidden" name="token" value={c.req.query('token') ?? ''} />
          <p style="margin:0">Continue to your workspaces.</p>
          <button type="submit">Sign in</button>
        </form>
      </Page>,
    ),
  );

  app.post('/login/link', async (c) => {
    const form = await c.req.parseBody();
    const used = cloud.accounts.useSignInLink(String(form.token ?? ''));
    if (!used) return c.html(<Message title="Link expired">This sign-in link has expired or was used already. Ask for a new one.</Message>, 404);
    const account = cloud.accounts.fromEmail(used.email);
    signIn(c, account);
    return c.redirect(safeNext(used.next), 303);
  });

  app.post('/logout', (c) => {
    const token = getCookie(c, ACCOUNT_COOKIE);
    if (token) cloud.accounts.deleteSession(token);
    deleteCookie(c, ACCOUNT_COOKIE, { path: '/' });
    return c.redirect('/', 303);
  });

  // --- your workspaces -----------------------------------------------------------

  app.get('/open/:id', (c) => {
    const account = c.get('account');
    if (!account) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
    const tenant = cloud.control.findById(c.req.param('id'));
    const member = tenant && cloud.accounts.memberships(account).some((m) => m.tenantId === tenant.id);
    if (!tenant || !member) return c.html(<Message title="Not your workspace">You're not a member of that workspace with this account.</Message>, 404);
    if (tenant.status !== 'active') return c.redirect(`/workspaces/${tenant.slug}`);
    return c.redirect(cloud.handoffUrl(tenant, account, '/admin'), 302);
  });
}

/** The signed-in home page: every workspace you belong to. */
export function WorkspacesPage({ account, cloud, siteUrl }: { account: Account; cloud: Cloud; siteUrl: string | null }) {
  const rows = cloud.accounts
    .memberships(account)
    .map((m) => ({ m, tenant: cloud.control.findById(m.tenantId) }))
    .filter((row) => !!row.tenant);
  const billing = rows.filter(({ tenant }) => tenant!.billingEmail?.toLowerCase() === account.email);
  return (
    <Page title="Your workspaces" siteUrl={siteUrl} aside={<AccountAside account={account} />}>
      <h1>Your workspaces</h1>
      {rows.length === 0 ? (
        <p>
          No workspaces for {account.email}
          {account.githubLogin ? ` or GitHub ${account.githubLogin}` : ''} yet. Start one, or ask a teammate for an invite. A workspace you already
          use shows up here once your email there is confirmed (its admin page has the button).
        </p>
      ) : (
        <section>
          <table>
            {rows.map(({ m, tenant }, i) => (
              <tr>
                <td>
                  <strong>{tenant!.name}</strong>
                  <br />
                  <span class="muted">
                    {new URL(cloud.workspaceUrl(tenant!.slug)).host} · {m.role} · {isPlanId(tenant!.plan) ? PLANS[tenant!.plan].name : 'custom'}
                    {tenant!.status === 'suspended' ? ' · paused' : ''}
                  </span>
                </td>
                <td class="actions">
                  <a class={i === 0 ? 'button' : 'button secondary'} href={`/open/${tenant!.id}`}>
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </table>
        </section>
      )}
      <a class="button secondary" href="/signup">
        Create a workspace
      </a>
      {billing.map(({ tenant }) => (
        <p class="muted">
          Billing for {tenant!.name}: <a href={`/workspaces/${tenant!.slug}`}>plan and upgrades</a>.
        </p>
      ))}
    </Page>
  );
}

export function AccountAside({ account }: { account: Account }) {
  return (
    <form method="post" action="/logout" class="row">
      <span class="muted">{account.githubLogin ?? account.email}</span>
      <button type="submit" class="secondary" style="margin:0">
        Sign out
      </button>
    </form>
  );
}

function LoginPage({ github, next, siteUrl, error }: { github: boolean; next: string; siteUrl: string | null; error?: string }) {
  return (
    <Page title="Sign in" siteUrl={siteUrl}>
      <h1>Sign in to OpenParley</h1>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="box">
        {github && (
          <>
            <a class="button github" style="margin:0" href={`/auth/github?${new URLSearchParams({ next })}`}>
              Continue with GitHub
            </a>
            <p class="or">or</p>
          </>
        )}
        <form method="post" action="/login/email">
          <input type="hidden" name="next" value={next} />
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required autocomplete="email" />
          <button type="submit" class="secondary">
            Email me a sign-in link
          </button>
        </form>
      </div>
      <p class="muted">Signs you in to all your workspaces at once. Running your own OpenParley server? Sign in there instead.</p>
      <p>
        No workspace yet? <a href="/signup">Start one for free</a>.
      </p>
    </Page>
  );
}
