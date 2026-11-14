/** @jsxImportSource hono/jsx */
import type { ConnectMessage } from '@openparley/protocol';
import { brandFontsCss } from '@openparley/brand';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import type { Child } from 'hono/jsx';
import { confirmedEmails, verifyAssertion, type Identity } from './assertion';
import { githubAuthorizeUrl, githubIdentity } from './github';
import type { Config, Limits } from './config';
import { hashPassword, randomToken, verifyPassword } from './crypto';
import type { Mailer } from './mail';
import type { Notifier } from './notify';
import { RateLimiter } from './rate-limit';
import { scriptTag, setupPrompt } from './setup-prompt';
import { allows, isOrigin, isWildcard } from './origins';
import {
  NOTIFY_LEVELS,
  SESSION_TTL,
  type AgentToken,
  type Invite,
  type NotificationSettings,
  type NotifyLevel,
  type Project,
  type Repo,
  type User,
} from './repo';
import { agentNameSchema, emailSchema, handleSchema, nameSchema, parseOrigins, passwordSchema } from './validation';

const COOKIE = 'openparley_session';
// Verifying against a real hash for unknown emails keeps login timing uniform.
const DUMMY_HASH = await hashPassword(randomToken());

type Env = { Variables: { user: User | null; nonce: string } };
export type WebEnv = Env;

export interface WebOptions {
  repo: Repo;
  config: Config;
  /** Required to create the first account; printed to the server log on first boot. */
  setupToken: string;
  clientIp: (c: Context) => string;
  /** OAuth consent for agents; mounted here so it runs with the session, CSRF check and CSP. */
  authorize?: Hono<Env>;
  /** Null: invite links are only shown to the admin. */
  mailer?: Mailer | null;
  /** For the notification settings; without it the page says notifications are off. */
  notifier?: Notifier;
  /** An address whoever provisioned this server already confirmed; an owner who sets up with it starts confirmed. */
  verifiedOwnerEmail?: string | null;
}

/** The "Continue with GitHub" button: this server's own GitHub app, or the trusted front door's sign-in. */
export function externalSignIn(config: Config): { label: string; url: (next: string) => string } | null {
  if (config.github) return { label: 'Continue with GitHub', url: (next) => `/auth/github?${new URLSearchParams({ next })}` };
  const start = config.trustedSignIn?.startUrl;
  if (start) return { label: config.trustedSignIn!.label, url: (next) => withNext(start, next) };
  return null;
}

/** The front door's own sign-in (an emailed link), for people without a password or GitHub here. */
export function accountSignIn(config: Config): ((next: string) => string) | null {
  const url = config.trustedSignIn?.accountUrl;
  return url ? (next) => withNext(url, next) : null;
}

const withNext = (url: string, next: string) => `${url}${url.includes('?') ? '&' : '?'}${new URLSearchParams({ next })}`;

export function webRoutes({ repo, config, setupToken, clientIp, authorize, mailer = null, notifier, verifiedOwnerEmail = null }: WebOptions): Hono<Env> {
  const web = new Hono<Env>();
  const limiter = new RateLimiter(10, 15 * 60 * 1000);
  // Invite emails go to other people's inboxes and count against the mail quota.
  const inviteMail = new RateLimiter(30, 60 * 60 * 1000);
  const secure = config.publicUrl.startsWith('https://');
  const external = externalSignIn(config);
  const account = accountSignIn(config);
  const confirmMail = new RateLimiter(3, 60 * 60 * 1000);

  web.use('*', csrf({ origin: new URL(config.publicUrl).origin }));
  web.use('*', async (c, next) => {
    const token = getCookie(c, COOKIE);
    c.set('user', token ? repo.userForSession(token, 'web') : null);
    c.set('nonce', randomToken(16));
    await next();
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    c.header(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; script-src 'nonce-${c.get('nonce')}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
  });

  const signIn = (c: Context, user: User) => {
    setCookie(c, COOKIE, repo.createSession(user.id, 'web'), {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL / 1000,
    });
  };

  web.get('/', (c) => c.redirect(repo.hasUsers() ? '/admin' : '/setup'));

  // --- first-run setup ---------------------------------------------------

  web.get('/setup', (c) => {
    if (repo.hasUsers()) return c.redirect('/login');
    const token = c.req.query('token') ?? '';
    if (token !== setupToken) {
      return c.html(
        <Page title="Set up OpenParley">
          <h1>Set up OpenParley</h1>
          <p>Open the setup link that was printed in the server log when it started. It contains a one-time token.</p>
        </Page>,
        403,
      );
    }
    return c.html(<SetupPage privacyUrl={config.privacyUrl} token={token} />);
  });

  web.post('/setup', async (c) => {
    if (repo.hasUsers()) return c.redirect('/login');
    const form = await c.req.parseBody();
    if (form.token !== setupToken) return c.text('Invalid setup token.', 403);
    const values = { name: String(form.name ?? ''), email: String(form.email ?? '') };
    const account = await parseAccount(form);
    if ('error' in account) return c.html(<SetupPage privacyUrl={config.privacyUrl} token={setupToken} error={account.error} values={values} />, 400);
    const confirmed = !!verifiedOwnerEmail && verifiedOwnerEmail.toLowerCase() === account.email.toLowerCase();
    const user = repo.createUser({ ...account, role: 'owner', emailVerified: confirmed });
    signIn(c, user);
    return c.redirect('/admin');
  });

  // --- sign in / out -----------------------------------------------------

  web.get('/login', (c) => {
    if (!repo.hasUsers()) return c.redirect('/setup');
    const next = safeNext(c.req.query('next'));
    if (c.get('user')) return c.redirect(next);
    return c.html(<LoginPage privacyUrl={config.privacyUrl} next={next} external={external} account={account} />);
  });

  web.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const email = String(form.email ?? '').trim().toLowerCase();
    const next = safeNext(String(form.next ?? ''));
    const key = `${clientIp(c)}|${email}`;
    if (limiter.blocked(key)) {
      return c.html(<LoginPage privacyUrl={config.privacyUrl} next={next} email={email} external={external} account={account} error="Too many attempts. Wait a few minutes and try again." />, 429);
    }
    const user = repo.findActiveUserByEmail(email);
    // Accounts without a password (GitHub only) never match one.
    const valid = await verifyPassword(String(form.password ?? ''), user?.passwordHash || DUMMY_HASH);
    if (!user || !user.passwordHash || !valid) {
      limiter.fail(key);
      return c.html(<LoginPage privacyUrl={config.privacyUrl} next={next} email={email} external={external} account={account} error="That email and password don't match." />, 401);
    }
    limiter.reset(key);
    signIn(c, user);
    return c.redirect(next);
  });

  // --- signing in from elsewhere (GitHub, a trusted front door) ------------

  /**
   * Signs in whoever `identity` is: the account with that GitHub id, else the one with that email when
   * both sides confirmed it. Signed in already: links the GitHub account to you. No account, but `next` is
   * an invite: joins with it (the invite is the permission; the invited address stays the account's email).
   */
  const completeExternalSignIn = async (c: Context<Env>, identity: Identity, next: string) => {
    const confirmed = confirmedEmails(identity);
    const current = c.get('user');
    if (current) {
      if (identity.githubId && !repo.linkGithub(current.id, identity.githubId, identity.githubLogin ?? null)) {
        return renderAdmin(c, { error: 'That GitHub account belongs to another account here.' }, 400);
      }
      if (confirmed.includes(current.email.toLowerCase())) repo.markEmailVerified(current.id);
      return c.redirect(safeNext(next));
    }
    let user = identity.githubId ? repo.findActiveUserByGithub(identity.githubId) : null;
    for (const email of confirmed) {
      if (user) break;
      const byEmail = repo.findActiveUserByEmail(email);
      if (byEmail?.emailVerified) user = byEmail;
    }
    if (user) {
      if (identity.githubId && !user.githubId) repo.linkGithub(user.id, identity.githubId, identity.githubLogin ?? null);
      if (confirmed.includes(user.email.toLowerCase())) repo.markEmailVerified(user.id);
      signIn(c, user);
      return c.redirect(safeNext(next));
    }
    const inviteToken = /^\/invite\/([A-Za-z0-9_-]+)$/.exec(next)?.[1];
    const invite = inviteToken ? repo.findUsableInvite(inviteToken) : null;
    if (invite && (identity.email || invite.email)) {
      if (membersFull()) return c.html(<Message title="No seats left">This OpenParley server is full. Ask an admin to make room, then use this link again.</Message>, 403);
      const email = invite.email ?? identity.email!;
      if (repo.emailTaken(email)) return c.html(<Message title="Account exists">An account with {email} already exists here. Sign in to it instead.</Message>, 409);
      const joined = repo.acceptInvite(inviteToken!, {
        email,
        name: identity.name || identity.githubLogin || email.split('@')[0]!,
        passwordHash: '',
        emailVerified: confirmed.includes(email.toLowerCase()),
        githubId: identity.githubId ?? null,
        githubLogin: identity.githubLogin ?? null,
      });
      if (joined) {
        signIn(c, joined);
        return c.redirect('/admin?welcome=1');
      }
    }
    const who = identity.githubLogin ? `GitHub account ${identity.githubLogin}` : (identity.email ?? 'that account');
    return c.html(
      <Message title="No account here">
        There's no account for {who} on this server{identity.githubLogin ? ' yet' : ''}. Ask an admin for an invite link, or sign in with your email and
        password and connect GitHub on the admin page.
      </Message>,
      403,
    );
  };

  web.get('/auth/handoff', async (c) => {
    const door = config.trustedSignIn;
    if (!door) return c.notFound();
    const verified = verifyAssertion(door.key, config.publicUrl, c.req.query('token') ?? '');
    if (!verified || !repo.useAssertion(verified.nonce, verified.exp)) {
      return c.html(<Message title="Sign-in link expired">This sign-in link has expired or was used already. Go back and try again.</Message>, 400);
    }
    return completeExternalSignIn(c, verified.identity, c.req.query('next') ?? '/admin');
  });

  // This server's own GitHub app (self-hosting). The state cookie ties the callback to this browser.
  const GITHUB_STATE = 'openparley_github';
  web.get('/auth/github', (c) => {
    if (!config.github) return c.notFound();
    const state = randomToken(16);
    setCookie(c, GITHUB_STATE, `${state}|${safeNext(c.req.query('next'))}`, { httpOnly: true, secure, sameSite: 'Lax', path: '/auth/github', maxAge: 600 });
    return c.redirect(githubAuthorizeUrl(config.github, `${config.publicUrl}/auth/github/callback`, state));
  });

  web.get('/auth/github/callback', async (c) => {
    if (!config.github) return c.notFound();
    const [state, next = '/admin'] = (getCookie(c, GITHUB_STATE) ?? '').split('|');
    deleteCookie(c, GITHUB_STATE, { path: '/auth/github' });
    const code = c.req.query('code');
    if (!state || !code || c.req.query('state') !== state) {
      return c.html(<Message title="Sign-in expired">That GitHub sign-in didn't come from this browser, or took too long. Try again.</Message>, 400);
    }
    let identity: Identity;
    try {
      identity = await githubIdentity(config.github, code, `${config.publicUrl}/auth/github/callback`);
    } catch (error) {
      console.error('GitHub sign-in failed:', error);
      return c.html(<Message title="GitHub sign-in failed">GitHub didn't confirm who you are. Try again in a moment.</Message>, 502);
    }
    return completeExternalSignIn(c, identity, next);
  });

  // --- confirming an email address -----------------------------------------

  web.post('/admin/email-confirmation', async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;
    const user = c.get('user')!;
    if (user.emailVerified) return c.redirect('/admin');
    if (!mailer || confirmMail.blocked(user.id)) return renderAdmin(c, { error: "We couldn't send the confirmation email. Try again later." }, 400);
    confirmMail.fail(user.id);
    const link = `${config.publicUrl}/confirm-email/${repo.createEmailConfirmation(user.id, user.email)}`;
    try {
      await mailer.send({
        to: user.email,
        subject: 'Confirm your email for OpenParley',
        text: ['To confirm this is your address on OpenParley, open:', link, '', "The link works for 24 hours. If you didn't ask for this, ignore this email."].join('\n'),
      });
    } catch (error) {
      console.error('Sending an email confirmation failed:', error);
      return renderAdmin(c, { error: "We couldn't send the confirmation email. Try again later." }, 400);
    }
    return renderAdmin(c, { confirmation: user.email });
  });

  // Opening the link changes nothing (mail scanners prefetch links); the button confirms.
  web.get('/confirm-email/:token', (c) =>
    c.html(
      <Page title="Confirm your email">
        <h1>Confirm your email</h1>
        <form method="post">
          <button type="submit">Confirm my email</button>
        </form>
      </Page>,
    ),
  );

  web.post('/confirm-email/:token', (c) => {
    const user = repo.confirmEmail(c.req.param('token'));
    if (!user) return c.html(<Message title="Link expired">This confirmation link has expired or was used already. Ask for a new one on the admin page.</Message>, 404);
    return c.html(<Message title="Email confirmed">{user.email} is confirmed. You can close this page.</Message>);
  });

  web.post('/admin/github/disconnect', (c) => {
    const denied = requireUser(c);
    if (denied) return denied;
    const user = c.get('user')!;
    if (!user.passwordHash) return renderAdmin(c, { error: "GitHub is your only way to sign in here, so it can't be disconnected." }, 400);
    repo.unlinkGithub(user.id);
    return c.redirect('/admin');
  });

  web.post('/logout', (c) => {
    const token = getCookie(c, COOKIE);
    if (token) repo.deleteSession(token);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.redirect('/login');
  });

  // --- overlay sign-in popup ---------------------------------------------

  const connectUrl = (projectId: string, origin: string) => `/connect?${new URLSearchParams({ project: projectId, origin })}`;

  web.get('/connect', (c) => {
    const projectId = c.req.query('project') ?? '';
    const origin = c.req.query('origin') ?? '';
    const project = repo.findProject(projectId);
    if (!project) {
      return c.html(<Message title="Unknown project">This site is configured with a project key that doesn't exist on this server.</Message>, 404);
    }
    if (!isOrigin(origin)) return c.html(<Message title="Unknown site">This sign-in link doesn't say which site it's for.</Message>, 400);
    const user = c.get('user');
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(connectUrl(project.id, origin))}`);
    if (!allows(project.origins, origin)) {
      // Only an admin can widen the list, and only deliberately: never for members, never by default.
      if (user.role === 'member') {
        return c.html(
          <Message title="Site not allowed">
            <code>{origin}</code> isn't one of the sites of <strong>{project.name}</strong>. Ask an admin of this workspace to add it.
          </Message>,
          403,
        );
      }
      return c.html(<AllowOriginPage project={project} origin={origin} />, 403);
    }

    const message: ConnectMessage = { type: 'openparley:connect', token: repo.createSession(user.id, 'api') };
    const script = `(() => {
      const message = ${scriptJson(message)};
      if (window.opener) {
        window.opener.postMessage(message, ${scriptJson(origin)});
        window.close();
      }
      document.getElementById('status').textContent = 'You are signed in. You can close this window.';
    })();`;
    return c.html(
      <Page title="Signing in">
        <h1>Signing in…</h1>
        <p id="status">
          Connecting {user.name} to <code>{origin}</code>.
        </p>
        <script nonce={c.get('nonce')} dangerouslySetInnerHTML={{ __html: script }} />
      </Page>,
    );
  });

  web.post('/connect/allow', async (c) => {
    const form = await c.req.parseBody();
    const project = repo.findProject(String(form.project ?? ''));
    const origin = String(form.origin ?? '');
    const user = c.get('user');
    if (!project || !isOrigin(origin)) return c.html(<Message title="Unknown site">This request doesn't name a project and a site.</Message>, 400);
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(connectUrl(project.id, origin))}`);
    if (user.role === 'member') return c.html(<Message title="Admins only">Ask an admin of this workspace to add the site.</Message>, 403);
    if (!allows(project.origins, origin)) repo.updateProject(project.id, project.name, [...project.origins, origin]);
    return c.redirect(connectUrl(project.id, origin), 303);
  });

  // --- invites -----------------------------------------------------------

  web.get('/invite/:token', (c) => {
    const invite = repo.findUsableInvite(c.req.param('token'));
    if (!invite) return c.html(<Message title="Invite expired">This invite link is invalid, already used, or expired. Ask for a new one.</Message>, 404);
    return c.html(
      <InvitePage
        privacyUrl={config.privacyUrl}
        token={c.req.param('token')}
        values={invite.email ? { name: '', email: invite.email } : undefined}
        external={external}
        account={account}
      />,
    );
  });

  web.post('/invite/:token', async (c) => {
    const token = c.req.param('token');
    const key = `${clientIp(c)}|invite`;
    if (limiter.blocked(key)) return c.text('Too many attempts. Try again later.', 429);
    if (!repo.findUsableInvite(token)) {
      limiter.fail(key);
      return c.html(<Message title="Invite expired">This invite link is invalid, already used, or expired. Ask for a new one.</Message>, 404);
    }
    const form = await c.req.parseBody();
    const values = { name: String(form.name ?? ''), email: String(form.email ?? '') };
    const account = await parseAccount(form);
    if ('error' in account) return c.html(<InvitePage privacyUrl={config.privacyUrl} token={token} error={account.error} values={values} external={external} account={accountSignIn(config)} />, 400);
    if (membersFull()) {
      return c.html(<Message title="No seats left">This OpenParley server is full. Ask an admin to make room, then use this link again.</Message>, 403);
    }
    const user = repo.acceptInvite(token, account);
    if (!user) return c.html(<Message title="Invite expired">This invite link is invalid, already used, or expired. Ask for a new one.</Message>, 404);
    signIn(c, user);
    return c.redirect('/admin?welcome=1');
  });

  async function parseAccount(form: Record<string, unknown>) {
    const name = nameSchema.safeParse(form.name);
    const email = emailSchema.safeParse(form.email);
    const password = passwordSchema.safeParse(form.password);
    for (const result of [name, email, password]) {
      if (!result.success) return { error: result.error.issues[0]!.message };
    }
    if (repo.emailTaken(email.data!)) return { error: 'An account with that email already exists.' };
    return { name: name.data!, email: email.data!, passwordHash: await hashPassword(password.data!) };
  }

  // --- admin -------------------------------------------------------------

  const requireUser = (c: Context<Env>) => {
    const user = c.get('user');
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
    return null;
  };
  const requireAdmin = (c: Context<Env>) => {
    const redirect = requireUser(c);
    if (redirect) return redirect;
    const user = c.get('user')!;
    if (user.role === 'member') return c.html(<Message title="Admins only">Ask an admin of this OpenParley server to do this.</Message>, 403);
    return null;
  };

  const renderAdmin = (c: Context<Env>, flash?: Flash, status: 200 | 400 = 200) =>
    c.html(
      <AdminPage
        user={c.get('user')!}
        projects={repo.listProjects()}
        members={repo.listActiveUsers()}
        invites={repo.listPendingInvites()}
        publicUrl={config.publicUrl}
        limits={config.limits}
        limitsUrl={config.limitsUrl}
        threadsCreated={repo.threadsCreated()}
        agents={repo.listAgentTokens(c.get('user')!.id)}
        notifications={{
          settings: repo.notificationSettings(c.get('user')!.id),
          channels: (notifier?.channels ?? []).map((channel) => ({ id: channel.id, label: channel.label, defaultOn: channel.defaultOn, address: channel.address(c.get('user')!) })),
          quietSeconds: Math.round((notifier?.quietMs ?? 60_000) / 1000),
        }}
        flash={flash}
        nonce={c.get('nonce')}
        canConfirmEmail={!!mailer}
        external={external}
      />,
      status,
    );

  web.get(
    '/admin',
    (c) =>
      requireUser(c) ??
      renderAdmin(c, c.req.query('welcome') === '1' ? { welcome: true } : savedFlash(c.req.query('saved'))),
  );

  web.post('/admin/handle', async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;
    const form = await c.req.parseBody();
    const handle = handleSchema.safeParse(form.handle);
    if (!handle.success) return renderAdmin(c, { error: handle.error.issues[0]!.message }, 400);
    if (!repo.setHandle(c.get('user')!.id, handle.data)) return renderAdmin(c, { error: `@${handle.data} is taken. Try another one.` }, 400);
    return c.redirect('/admin?saved=handle#notifications', 303);
  });

  web.post('/admin/notifications', async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;
    const user = c.get('user')!;
    const form = await c.req.parseBody();
    const level = asLevel(form.level) ?? 'participating';
    const projects: Record<string, NotifyLevel> = {};
    for (const project of repo.listProjects()) {
      const override = asLevel(form[`project:${project.id}`]);
      if (override && override !== level) projects[project.id] = override;
    }
    repo.saveNotificationLevels(user.id, level, projects);
    for (const channel of notifier?.channels ?? []) repo.setNotificationChannel(user.id, channel.id, form[`channel:${channel.id}`] === 'on');
    return c.redirect('/admin?saved=notifications#notifications', 303);
  });

  const { limits } = config;
  const membersFull = () => limits.members !== null && repo.listActiveUsers().length >= limits.members;
  const seatsTaken = () => repo.listActiveUsers().length + repo.listPendingInvites().length;

  // Every signed-in user manages their own agents; an agent can do what its user can in the overlay, minus deleting.
  web.post('/admin/agents', async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;
    const form = await c.req.parseBody();
    const name = agentNameSchema.safeParse(form.name);
    if (!name.success) return renderAdmin(c, { error: name.error.issues[0]!.message }, 400);
    const { token } = repo.createAgentToken(c.get('user')!.id, name.data);
    // Rendered directly (not redirected) so the token never lands in a URL or browser history.
    return renderAdmin(c, { agent: { name: name.data, token } });
  });

  web.post('/admin/agents/:id/revoke', (c) => {
    const denied = requireUser(c);
    if (denied) return denied;
    repo.deleteAgentToken(c.req.param('id'), c.get('user')!.id);
    return c.redirect('/admin');
  });

  web.post('/admin/projects', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    if (limits.projects !== null && repo.listProjects().length >= limits.projects) {
      return renderAdmin(c, { error: `This server allows up to ${limits.projects} projects. Delete one or raise the limit.` }, 400);
    }
    const form = await c.req.parseBody();
    const name = String(form.name ?? '').trim().slice(0, 80);
    const origins = parseOrigins(String(form.origins ?? ''));
    if (!name) return renderAdmin(c, { error: 'Give the project a name.' }, 400);
    if ('error' in origins) return renderAdmin(c, { error: origins.error }, 400);
    repo.createProject(name, origins.origins);
    return c.redirect('/admin');
  });

  web.post('/admin/projects/:id', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const project = repo.findProject(c.req.param('id'));
    if (!project) return c.redirect('/admin');
    const form = await c.req.parseBody();
    if (form.action === 'delete') {
      if (form.confirm !== 'yes') return renderAdmin(c, { error: `Tick the box to confirm deleting ${project.name}.` }, 400);
      repo.deleteProject(project.id);
      return c.redirect('/admin');
    }
    const name = String(form.name ?? '').trim().slice(0, 80) || project.name;
    const origins = parseOrigins(String(form.origins ?? ''));
    if ('error' in origins) return renderAdmin(c, { error: origins.error }, 400);
    repo.updateProject(project.id, name, origins.origins);
    return c.redirect('/admin');
  });

  web.post('/admin/invites', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const form = await c.req.parseBody();
    const role = form.role === 'admin' ? 'admin' : 'member';
    const rawEmail = String(form.email ?? '').trim();
    const email = rawEmail ? emailSchema.safeParse(rawEmail) : null;
    if (email && !email.success) return renderAdmin(c, { error: email.error.issues[0]!.message }, 400);
    if (limits.members !== null && seatsTaken() >= limits.members) {
      return renderAdmin(
        c,
        {
          error: `This ${config.limitsUrl ? 'plan' : 'server'} allows up to ${limits.members} ${limits.members === 1 ? 'member' : 'members'}, counting pending invites. ${config.limitsUrl ? 'Use "Add more seats" next to Members to upgrade, or remove someone first.' : 'Remove someone or revoke an invite first.'}`,
        },
        400,
      );
    }
    const inviter = c.get('user')!;
    const { token } = repo.createInvite(role, inviter.id, email?.data ?? null);
    const link = `${config.publicUrl}/invite/${token}`;
    // Rendered directly (not redirected) so the token never lands in a URL or browser history.
    if (!email) return renderAdmin(c, { invite: link });
    if (!mailer) return renderAdmin(c, { invite: link, to: email.data, mail: 'off' });
    if (inviteMail.blocked(inviter.id)) return renderAdmin(c, { invite: link, to: email.data, mail: 'failed' });
    inviteMail.fail(inviter.id);
    try {
      await mailer.send(inviteEmail({ to: email.data, inviter, link, projects: repo.listProjects() }));
      return renderAdmin(c, { invite: link, to: email.data, mail: 'sent' });
    } catch (error) {
      console.error('Sending an invite failed:', error);
      return renderAdmin(c, { invite: link, to: email.data, mail: 'failed' });
    }
  });

  web.post('/admin/invites/:id/revoke', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    repo.revokeInvite(c.req.param('id'));
    return c.redirect('/admin');
  });

  web.post('/admin/members/:id', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const target = repo.findActiveUser(c.req.param('id'));
    const me = c.get('user')!;
    if (!target || target.role === 'owner' || target.id === me.id) return c.redirect('/admin');
    const form = await c.req.parseBody();
    if (form.action === 'remove') {
      if (form.confirm !== 'yes') return renderAdmin(c, { error: `Tick the box to confirm removing ${target.name}.` }, 400);
      repo.removeUser(target.id);
    } else {
      repo.setRole(target.id, form.role === 'admin' ? 'admin' : 'member');
    }
    return c.redirect('/admin');
  });

  if (authorize) web.route('/oauth/authorize', authorize);

  return web;
}

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

const savedFlash = (saved: string | undefined): Flash | undefined => (saved === 'notifications' || saved === 'handle' ? { saved } : undefined);

const asLevel = (value: unknown): NotifyLevel | null => (NOTIFY_LEVELS as readonly unknown[]).includes(value) ? (value as NotifyLevel) : null;

const LEVEL_LABELS: Record<NotifyLevel, string> = {
  off: 'Nothing',
  mentions: 'Only when someone mentions me',
  participating: "Mentions, and threads I'm in",
  everything: 'Everything: every new thread and reply',
};

/**
 * `/unsubscribe/:token`, the link in every notification email. Opening it changes nothing (mail
 * scanners prefetch links); the button, or a mail client's one-click POST (RFC 8058), switches
 * email notifications off. The token is the credential, so there's no session or CSRF check.
 */
export function unsubscribeRoutes(repo: Repo): Hono {
  const routes = new Hono();
  routes.use('*', async (c, next) => {
    await next();
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  });
  const gone = (c: Context) =>
    c.html(<Message title="Link expired">This unsubscribe link doesn't work anymore. Sign in to change your notification settings.</Message>, 404);
  routes.get('/:token', (c) => {
    const user = repo.userForUnsubscribeToken(c.req.param('token'));
    if (!user) return gone(c);
    return c.html(
      <Page title="Unsubscribe">
        <h1>Stop notification emails?</h1>
        <p>{user.email} won't get emails about threads and mentions anymore.</p>
        <form method="post">
          <button type="submit">Unsubscribe</button>
        </form>
      </Page>,
    );
  });
  routes.post('/:token', (c) => {
    const user = repo.userForUnsubscribeToken(c.req.param('token'));
    if (!user) return gone(c);
    repo.setNotificationChannel(user.id, 'email', false);
    return c.html(
      <Page title="Unsubscribed">
        <h1>You're unsubscribed</h1>
        <p>
          {user.email} won't get notification emails anymore. Changed your mind? Switch them back on in your{' '}
          <a href="/admin#notifications">notification settings</a>.
        </p>
      </Page>,
    );
  });
  return routes;
}

/** Only same-site relative redirects, so `next` can't send people to another site. */
function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/admin';
}

function scriptJson(value: unknown): string {
  // Prevents a value containing "</script>" from ending the inline script early.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// --- views -----------------------------------------------------------------

const STYLE = `${brandFontsCss()}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#14181f;background:#fbf7ee;accent-color:#2c7f6b}
.logo{display:block}.logo img{display:block;height:30px;width:auto}
main{max-width:760px;margin:0 auto;padding:32px 20px 64px}h1{font-size:24px;margin:0 0 16px}h2{font-size:18px;margin:32px 0 12px}
a{color:#1f5a4c}code,pre{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f3ecdc;border-radius:4px;padding:1px 4px}
pre{padding:10px;white-space:pre-wrap;word-break:break-all}
section,.box{background:#fff;border:1px solid #e7dec9;border-radius:20px;padding:16px;margin:0 0 12px;box-shadow:0 8px 24px -8px rgb(90 67 16 / 0.08)}
label{display:block;font-weight:600;margin:12px 0 4px}input,select,textarea{font:inherit;width:100%;padding:8px 10px;border:1px solid #cfc3a8;border-radius:12px;background:#fff}
input:focus,select:focus,textarea:focus{outline:none;border-color:#2c7f6b;box-shadow:0 0 0 0.5px #2c7f6b}
textarea{min-height:64px}button{font:inherit;font-weight:700;padding:8px 16px;border-radius:999px;border:1px solid #2c7f6b;background:#2c7f6b;color:#fff;cursor:pointer;margin-top:12px}
button.secondary{background:#fff;color:#14181f;border-color:#cfc3a8}button.danger{background:#fff;color:#c2553c;border-color:#e8846b}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row>*{margin:0}.muted{color:#5e6672}.inline{display:inline}.check{display:flex;gap:6px;align-items:center;font-weight:400}.check input{width:auto}
.error{background:#fbe6df;border:1px solid #e8846b;color:#14181f;padding:10px 12px;border-radius:12px}.ok{background:#ddf1ea;border:1px solid #7cc7b2;padding:10px 12px;border-radius:12px}
fieldset{border:0;padding:0;margin:12px 0 0}legend{font-weight:600;padding:0;margin:0 0 4px}fieldset .check{display:block;margin:4px 0}fieldset .check input{margin:0 6px 0 0}
summary{cursor:pointer;margin:12px 0 0;color:#1f5a4c}details pre{margin:8px 0 0;word-break:normal;overflow-wrap:anywhere}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}table{width:100%;border-collapse:collapse}td{padding:8px 4px;border-top:1px solid #e7dec9;vertical-align:middle}
a.button{display:inline-block;font-weight:700;padding:8px 16px;border-radius:999px;border:1px solid #2c7f6b;background:#2c7f6b;color:#fff;text-decoration:none}a.button.github{background:#14181f;border-color:#14181f}
.notice{background:#f3ecdc;border:1px solid #e7dec9;padding:10px 12px;border-radius:12px;margin:0 0 12px}button.link{background:none;border:0;padding:0;margin:0;color:#1f5a4c;font-weight:400;text-decoration:underline}
`;

const COPY_SCRIPT = `document.addEventListener('change', (event) => {
  const id = event.target.dataset?.launcherFor;
  if (!id) return;
  for (const pre of [document.getElementById('snippet-' + id), document.getElementById('prompt-' + id)]) pre.textContent = pre.dataset[event.target.value];
  document.querySelector('[data-launcher-note="' + id + '"]').hidden = event.target.value !== 'members';
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-copy]');
  const source = button && document.getElementById(button.dataset.copy);
  if (!source) return;
  button.dataset.label ??= button.textContent;
  navigator.clipboard.writeText(source.textContent).then(
    () => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = button.dataset.label; }, 1500); },
    () => { source.closest('details')?.setAttribute('open', ''); },
  );
});`;

/** `aside` sits in the header next to the logo (e.g. the signed-in user and Sign out). */
export function Page({ title, aside, children }: { title: string; aside?: Child; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        <title>{title} · OpenParley</title>
        <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        <main>
          <header>
            <a class="logo" href="/">
              <img src="/brand/logo-light.svg" alt="OpenParley" width="124" height="30" />
            </a>
            {aside}
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}

function Message({ title, children }: { title: string; children: Child }) {
  return (
    <Page title={title}>
      <h1>{title}</h1>
      <p>{children}</p>
    </Page>
  );
}

function AllowOriginPage({ project, origin }: { project: Project; origin: string }) {
  return (
    <Page title="Add this site?">
      <h1>Add this site?</h1>
      <p>
        <code>{origin}</code> isn't one of the sites of <strong>{project.name}</strong> yet. Add it and you're signed in there.
      </p>
      <p class="muted">
        Only add sites you run. Every site on the list can sign in anyone in this workspace who opens it, and read and post threads as them.
      </p>
      <form method="post" action="/connect/allow">
        <input type="hidden" name="project" value={project.id} />
        <input type="hidden" name="origin" value={origin} />
        <button type="submit">Add {origin}</button>
      </form>
      <p class="muted">Not your site? Close this window. You can always edit the list on the <a href="/admin">admin page</a>.</p>
    </Page>
  );
}

export function ErrorBox({ error }: { error?: string }) {
  return error ? (
    <p class="error" role="alert">
      {error}
    </p>
  ) : null;
}

function AccountFields({ values }: { values?: { name: string; email: string } }) {
  return (
    <>
      <label for="name">Name</label>
      <input id="name" name="name" required maxlength={80} autocomplete="name" value={values?.name} />
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" value={values?.email} />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required minlength={10} autocomplete="new-password" />
    </>
  );
}

function PrivacyLine({ privacyUrl }: { privacyUrl: string | null }) {
  return privacyUrl ? (
    <p class="muted">
      How your account details are handled: <a href={privacyUrl}>privacy policy</a>.
    </p>
  ) : null;
}

type AccountPageProps = {
  privacyUrl: string | null;
  token: string;
  error?: string;
  values?: { name: string; email: string };
  external?: External;
  account?: ((next: string) => string) | null;
};

function SetupPage({ privacyUrl, token, error, values }: AccountPageProps) {
  return (
    <Page title="Set up OpenParley">
      <h1>Set up OpenParley</h1>
      <p class="muted">Create the owner account for this server. You can invite your team afterwards.</p>
      <ErrorBox error={error} />
      <form method="post" class="box">
        <input type="hidden" name="token" value={token} />
        <AccountFields values={values} />
        <button type="submit">Create owner account</button>
      </form>
      <PrivacyLine privacyUrl={privacyUrl} />
    </Page>
  );
}

type External = { label: string; url: (next: string) => string } | null;

function ExternalButton({ external, next, label }: { external: External; next: string; label?: string }) {
  return external ? (
    <p>
      <a class="button github" href={external.url(next)}>
        {label ?? external.label}
      </a>
    </p>
  ) : null;
}

function AccountLink({ account, next, text }: { account?: ((next: string) => string) | null; next: string; text: string }) {
  return account ? (
    <p class="muted">
      {text} <a href={account(next)}>Use an emailed link</a>.
    </p>
  ) : null;
}

function LoginPage(props: { privacyUrl: string | null; next: string; email?: string; error?: string; external: External; account: ((next: string) => string) | null }) {
  const { privacyUrl, next, email, error, external, account } = props;
  return (
    <Page title="Sign in">
      <h1>Sign in to OpenParley</h1>
      <ErrorBox error={error} />
      <ExternalButton external={external} next={next} />
      <form method="post" action="/login" class="box">
        <input type="hidden" name="next" value={next} />
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email" value={email} autofocus />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password" />
        <button type="submit">Sign in</button>
      </form>
      <AccountLink account={account} next={next} text="No password?" />
      <p class="muted">No account? Ask an admin of this server for an invite link.</p>
      <PrivacyLine privacyUrl={privacyUrl} />
    </Page>
  );
}

/** How you sign in here. Shown only where there's a choice (GitHub available, or already linked). */
function Account({ user, external }: { user: User; external: External }) {
  if (!external && !user.githubId) return null;
  return (
    <>
      <h2>Your account</h2>
      <section>
        <table>
          <tr>
            <td>
              GitHub
              <br />
              <span class="muted">{user.githubId ? (user.githubLogin ?? 'connected') : 'not connected'}</span>
            </td>
            <td style="text-align:right">
              {user.githubId ? (
                user.passwordHash ? (
                  <form method="post" action="/admin/github/disconnect" class="inline">
                    <button type="submit" class="secondary">
                      Disconnect
                    </button>
                  </form>
                ) : (
                  <span class="muted">your only way to sign in</span>
                )
              ) : (
                external && (
                  <a class="button" href={external.url('/admin')}>
                    Connect GitHub
                  </a>
                )
              )}
            </td>
          </tr>
        </table>
      </section>
    </>
  );
}

/** Every site a teammate can open; `#openparley` switches the overlay on for them there. Wildcards can't be linked. */
function Sites({ projects }: { projects: Project[] }) {
  const sites = projects.flatMap((project) => project.origins.filter((origin) => !isWildcard(origin)).map((origin) => ({ project, origin })));
  if (sites.length === 0) return null;
  return (
    <>
      <h2>Your sites</h2>
      <p class="muted">Open a site to comment on it. The link switches OpenParley on in this browser.</p>
      <section>
        <table>
          {sites.map(({ project, origin }) => (
            <tr>
              <td>
                {project.name}
                <br />
                <span class="muted">{origin}</span>
              </td>
              <td style="text-align:right">
                <a href={`${origin}/#openparley`} target="_blank" rel="noopener">
                  Open
                </a>
              </td>
            </tr>
          ))}
        </table>
      </section>
    </>
  );
}

function inviteEmail({ to, inviter, link, projects }: { to: string; inviter: User; link: string; projects: Project[] }) {
  const names = projects.map((p) => p.name);
  const what = names.length === 0 ? 'your team\'s sites' : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return {
    to,
    replyTo: inviter.email,
    subject: `${inviter.name} invited you to OpenParley`,
    text: [
      `${inviter.name} invited you to review ${what} with OpenParley.`,
      '',
      'Point at any element of the live site and start a thread right there. Your team replies in the thread, and coding agents can pick it up, make the change and reply too. No screenshots, no "the second button, no, the other one".',
      '',
      'Create your account (the link works once, for 7 days):',
      link,
      '',
      "After that you'll see a link to each site that switches OpenParley on in your browser.",
    ].join('\n'),
  };
}

function InvitePage({ privacyUrl, token, error, values, external = null, account = null }: AccountPageProps) {
  return (
    <Page title="Join OpenParley">
      <h1>Join your team on OpenParley</h1>
      <ErrorBox error={error} />
      <ExternalButton external={external} next={`/invite/${token}`} label={external?.label.replace(/^Continue/, 'Join')} />
      {external && <p class="muted">Or create a password:</p>}
      <form method="post" action={`/invite/${encodeURIComponent(token)}`} class="box">
        <AccountFields values={values} />
        <button type="submit">Create account</button>
      </form>
      <AccountLink account={account} next={`/invite/${token}`} text="Rather not have a password?" />
      <PrivacyLine privacyUrl={privacyUrl} />
    </Page>
  );
}

type Flash =
  | { error: string }
  | { invite: string; to?: string; mail?: 'sent' | 'off' | 'failed' }
  | { agent: { name: string; token: string } }
  | { welcome: true }
  | { saved: 'notifications' | 'handle' }
  | { confirmation: string };

interface NotificationProps {
  settings: NotificationSettings;
  channels: Array<{ id: string; label: string; defaultOn: boolean; address: string | null }>;
  quietSeconds: number;
}

function Notifications({
  user,
  projects,
  settings,
  channels,
  quietSeconds,
  saved,
}: NotificationProps & { user: User; projects: Project[]; saved: 'notifications' | 'handle' | null }) {
  const admin = user.role !== 'member';
  return (
    <>
      <h2 id="notifications">Mentions and notifications</h2>
      {saved === 'handle' && <p class="ok">Mention name saved. Teammates mention you as @{user.handle}.</p>}
      <form method="post" action="/admin/handle" class="box">
        <label for="handle" style="margin-top:0">Your mention name</label>
        <div class="row">
          <span>@</span>
          <input id="handle" name="handle" value={user.handle} required maxlength={30} autocomplete="nickname" spellcheck={false} style="flex:1;width:auto" />
          <button type="submit" class="secondary">
            Save
          </button>
        </div>
        <span class="muted">Teammates and agents type @{user.handle} to mention you. Lowercase, no spaces; dots, dashes and underscores are fine.</span>
      </form>
      {channels.length === 0 ? (
        <p class="muted">
          This server doesn't send notifications yet.{' '}
          {admin ? (
            <>
              Set <code>RESEND_API_KEY</code> and <code>MAIL_FROM</code> to email people about replies and mentions.
            </>
          ) : (
            'Ask an admin to set up email.'
          )}
        </p>
      ) : (
        <>
          {saved === 'notifications' && <p class="ok">Notification settings saved.</p>}
          <p class="muted">
            Mention a teammate by typing <code>@</code> in a comment and picking them. Updates on a thread are sent together once it has been quiet for{' '}
            {quietSeconds >= 60 && quietSeconds % 60 === 0 ? `${quietSeconds / 60} minute${quietSeconds === 60 ? '' : 's'}` : `${quietSeconds} seconds`}, and
            never about what you did yourself.
          </p>
          <form method="post" action="/admin/notifications" class="box">
            <label for="notify-level">{projects.length > 1 ? 'In all projects, notify me about' : 'Notify me about'}</label>
            <select id="notify-level" name="level">
              {NOTIFY_LEVELS.map((level) => (
                <option value={level} selected={settings.level === level}>
                  {LEVEL_LABELS[level]}
                </option>
              ))}
            </select>
            {projects.length > 1 &&
              projects.map((project) => (
                <>
                  <label for={`notify-${project.id}`}>{project.name}</label>
                  <select id={`notify-${project.id}`} name={`project:${project.id}`}>
                    <option value="" selected={!settings.projects[project.id]}>
                      Same as all projects
                    </option>
                    {NOTIFY_LEVELS.map((level) => (
                      <option value={level} selected={settings.projects[project.id] === level}>
                        {LEVEL_LABELS[level]}
                      </option>
                    ))}
                  </select>
                </>
              ))}
            <label>Send them to</label>
            {channels.map((channel) => (
              <label class="check">
                <input
                  type="checkbox"
                  name={`channel:${channel.id}`}
                  checked={settings.channels[channel.id] ?? channel.defaultOn}
                  disabled={channel.address === null}
                />{' '}
                {channel.label}
                {channel.address && <span class="muted"> ({channel.address})</span>}
              </label>
            ))}
            <button type="submit">Save</button>
          </form>
        </>
      )}
    </>
  );
}

function AdminPage(props: {
  user: User;
  projects: Project[];
  members: User[];
  invites: Invite[];
  publicUrl: string;
  limits: Limits;
  limitsUrl: string | null;
  threadsCreated: number;
  agents: AgentToken[];
  notifications: NotificationProps;
  flash?: Flash;
  nonce: string;
  canConfirmEmail: boolean;
  external: External;
}) {
  const { user, projects, members, invites, publicUrl, limits, limitsUrl, threadsCreated, agents, notifications, flash, nonce, canConfirmEmail, external } = props;
  const admin = user.role !== 'member';
  return (
    <Page
      title="Admin"
      aside={
        <form method="post" action="/logout" class="row">
          <span class="muted">
            {user.name} · {user.role}
          </span>
          <button type="submit" class="secondary">
            Sign out
          </button>
        </form>
      }
    >
      {flash && 'error' in flash && <ErrorBox error={flash.error} />}
      {flash && 'invite' in flash && (
        <div class="ok">
          {flash.mail === 'sent' ? (
            <>
              <strong>Invite sent to {flash.to}.</strong> The link works once and expires in 7 days. If it doesn't arrive, send them this link yourself:
            </>
          ) : (
            <>
              <strong>Invite link created.</strong>{' '}
              {flash.mail === 'off'
                ? "This server doesn't send email, so send it to them yourself. "
                : flash.mail === 'failed'
                  ? `We couldn't email ${flash.to}, so send it to them yourself. `
                  : 'Send it to the person you\'re inviting. '}
              It works once and expires in 7 days, and it won't be shown again.
            </>
          )}
          <pre>{flash.invite}</pre>
        </div>
      )}
      {flash && 'agent' in flash && (
        <div class="ok">
          <strong>{flash.agent.name} can now read and answer threads.</strong> Copy the token now: it won't be shown again. In Claude Code, run:
          <pre>{`claude mcp add --transport http openparley ${publicUrl}/mcp --header "Authorization: Bearer ${flash.agent.token}"`}</pre>
          Other MCP clients: server URL <code>{`${publicUrl}/mcp`}</code> (Streamable HTTP), header <code>Authorization: Bearer {flash.agent.token}</code>.
        </div>
      )}
      {flash && 'welcome' in flash && (
        <div class="ok">
          <strong>Welcome, {user.name}.</strong> Open one of your team's sites below: OpenParley switches on in this browser. Click any element (or
          press C first) to start a thread on it.
        </div>
      )}
      {flash && 'confirmation' in flash && (
        <div class="ok" role="status">
          We've sent a link to {flash.confirmation}. Open it to confirm your email; it works for 24 hours.
        </div>
      )}
      {!user.emailVerified && canConfirmEmail && !(flash && 'confirmation' in flash) && (
        <form method="post" action="/admin/email-confirmation" class="notice">
          <strong>Confirm {user.email}</strong> so you can sign in with GitHub or from your OpenParley account.{' '}
          <button type="submit" class="link">
            Send the confirmation email
          </button>
        </form>
      )}
      <Sites projects={projects} />
      <Account user={user} external={external} />
      <Notifications user={user} projects={projects} {...notifications} saved={flash && 'saved' in flash ? flash.saved : null} />
      {!admin && <p class="muted">Admins manage projects and members on this page.</p>}

      {admin && (
        <>
          <h2>
            Projects
            {limits.threads !== null && (
              <span class="muted">
                {' '}
                · {threadsCreated} of {limits.threads} threads used
                {limitsUrl && (
                  <>
                    {' '}
                    · <a href={limitsUrl}>{threadsCreated >= limits.threads ? 'Raise the limit' : 'Plans'}</a>
                  </>
                )}
              </span>
            )}
          </h2>
          <p class="muted">
            A project is one site or app. List every origin (scheme + host + port) where the snippet runs, or a wildcard such as{' '}
            <code>https://*.preview.example.com</code> for all its subdomains. Admins can also add a site from the sign-in window the first time
            they use it there. A wildcard on a shared host (<code>*.vercel.app</code>) admits other people's sites too.
          </p>
          {projects.map((project) => (
            <section>
              <form method="post" action={`/admin/projects/${project.id}`}>
                <label for={`name-${project.id}`}>Name</label>
                <input id={`name-${project.id}`} name="name" value={project.name} maxlength={80} />
                <label for={`origins-${project.id}`}>Allowed sites (one per line)</label>
                <textarea id={`origins-${project.id}`} name="origins">
                  {project.origins.join('\n')}
                </textarea>
                <button type="submit">Save</button>
              </form>
              <fieldset>
                <legend>Who loads OpenParley</legend>
                <label class="check">
                  <input type="radio" name={`launcher-${project.id}`} value="members" data-launcher-for={project.id} autocomplete="off" checked /> Only signed-in
                  teammates <span class="muted">Recommended: everyone else downloads a 1 KB loader and nothing more.</span>
                </label>
                <label class="check">
                  <input type="radio" name={`launcher-${project.id}`} value="always" data-launcher-for={project.id} autocomplete="off" /> Every visitor{' '}
                  <span class="muted">For sites only your team opens, like local dev or a private staging.</span>
                </label>
              </fieldset>
              <p class="muted" style="margin:8px 0 0" data-launcher-note={project.id}>
                With signed-in teammates only, switch it on once in each browser: open the site with <code>#openparley</code> at the end of the URL
                (your sites are linked at the top of this page) and sign in.
              </p>
              <label>Snippet</label>
              <pre
                id={`snippet-${project.id}`}
                data-members={scriptTag(publicUrl, project.id, 'members')}
                data-always={scriptTag(publicUrl, project.id, 'always')}
              >
                {scriptTag(publicUrl, project.id, 'members')}
              </pre>
              <button type="button" class="secondary" data-copy={`snippet-${project.id}`}>
                Copy snippet
              </button>
              <label>Set up with your coding agent</label>
              <p class="muted" style="margin:0">
                Paste this prompt into Claude Code, Cursor or Codex in your app's repository. It adds the snippet, connects the agent to this
                workspace and tells future agents how to work through threads.
              </p>
              <button type="button" data-copy={`prompt-${project.id}`}>
                Copy prompt
              </button>
              <details>
                <summary>Show the prompt</summary>
                <pre
                  id={`prompt-${project.id}`}
                  data-members={setupPrompt({ server: publicUrl, project: project.id, launcher: 'members' })}
                  data-always={setupPrompt({ server: publicUrl, project: project.id, launcher: 'always' })}
                >
                  {setupPrompt({ server: publicUrl, project: project.id, launcher: 'members' })}
                </pre>
              </details>
              <form method="post" action={`/admin/projects/${project.id}`} class="row">
                <input type="hidden" name="action" value="delete" />
                <label class="check">
                  <input type="checkbox" name="confirm" value="yes" required /> Delete this project and all its threads
                </label>
                <button type="submit" class="danger">
                  Delete project
                </button>
              </form>
            </section>
          ))}
          <form method="post" action="/admin/projects" class="box">
            <strong>New project</strong>
            <label for="new-name">Name</label>
            <input id="new-name" name="name" required maxlength={80} placeholder="Marketing site" />
            <label for="new-origins">Allowed sites (one per line)</label>
            <textarea id="new-origins" name="origins" placeholder={'https://www.example.com\nhttps://staging.example.com'} />
            <button type="submit">Create project</button>
          </form>

          <h2>
            Members
            {limits.members !== null && (
              <span class="muted">
                {' '}
                · {members.length + invites.length} of {limits.members} seats used
                {limitsUrl && (
                  <>
                    {' '}
                    · <a href={limitsUrl}>{members.length + invites.length >= limits.members ? 'Add more seats' : 'Plans'}</a>
                  </>
                )}
              </span>
            )}
          </h2>
          <section>
            <table>
              {members.map((member) => (
                <tr>
                  <td>
                    {member.name} <span class="muted">@{member.handle}</span>
                    <br />
                    <span class="muted">{member.email}</span>
                  </td>
                  <td>
                    {member.role === 'owner' || member.id === user.id ? (
                      <span class="muted">{member.role}</span>
                    ) : (
                      <form method="post" action={`/admin/members/${member.id}`} class="row">
                        <select name="role" aria-label={`Role for ${member.name}`}>
                          <option value="member" selected={member.role === 'member'}>
                            member
                          </option>
                          <option value="admin" selected={member.role === 'admin'}>
                            admin
                          </option>
                        </select>
                        <button type="submit" class="secondary">
                          Save
                        </button>
                      </form>
                    )}
                  </td>
                  <td>
                    {member.role !== 'owner' && member.id !== user.id && (
                      <form method="post" action={`/admin/members/${member.id}`} class="row">
                        <input type="hidden" name="action" value="remove" />
                        <label class="check">
                          <input type="checkbox" name="confirm" value="yes" required /> confirm
                        </label>
                        <button type="submit" class="danger">
                          Remove
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </table>
          </section>
          <form method="post" action="/admin/invites" class="box row">
            <span>Invite</span>
            <input name="email" type="email" placeholder="name@company.com (optional)" aria-label="Email of the person you're inviting" style="flex:1;min-width:200px" />
            <span>as</span>
            <select name="role" style="width:auto">
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
            <button type="submit">Invite</button>
          </form>
          {invites.length > 0 && (
            <section>
              <strong>Pending invites</strong>
              <table>
                {invites.map((invite) => (
                  <tr>
                    <td>
                      {invite.email ? `${invite.email} (${invite.role})` : `${invite.role} invite`}, expires {new Date(invite.expiresAt).toISOString().slice(0, 10)}
                    </td>
                    <td>
                      <form method="post" action={`/admin/invites/${invite.id}/revoke`}>
                        <button type="submit" class="secondary">
                          Revoke
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </table>
            </section>
          )}
        </>
      )}

      <h2>Agents</h2>
      <p class="muted">
        Let a coding agent (Claude Code, Cursor, …) read threads over MCP, reply on your behalf and resolve them. Its replies show as written by the
        agent for {user.name}. Agents can't delete threads or manage the server.
      </p>
      <section>
        <strong>Connect by signing in</strong>
        <p style="margin:4px 0 0">Add this server to your agent. The first time, it opens this site so you can approve it.</p>
        <pre>{`claude mcp add --transport http openparley ${publicUrl}/mcp`}</pre>
        <span class="muted">
          Then run <code>/mcp</code> in Claude Code and choose Authenticate. Other agents: add <code>{`${publicUrl}/mcp`}</code> as a remote (HTTP) MCP
          server.
        </span>
      </section>
      {agents.length > 0 && (
        <section>
          <table>
            {agents.map((agent) => (
              <tr>
                <td>
                  {agent.name}
                  <br />
                  <span class="muted">
                    {agent.clientId ? 'signed in' : 'token added'} {day(agent.createdAt)} ·{' '}
                    {agent.lastUsedAt ? `last used ${day(agent.lastUsedAt)}` : 'not used yet'}
                  </span>
                </td>
                <td style="text-align:right">
                  <form method="post" action={`/admin/agents/${agent.id}/revoke`}>
                    <button type="submit" class="secondary" aria-label={`Revoke ${agent.name}`}>
                      Revoke
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </table>
        </section>
      )}
      <form method="post" action="/admin/agents" class="box">
        <strong>Or use a token</strong> <span class="muted">for agents that can't sign in</span>
        <label for="agent-name">Agent name</label>
        <input id="agent-name" name="name" required maxlength={40} value="Claude Code" />
        <button type="submit">Create a token</button>
      </form>
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
    </Page>
  );
}
