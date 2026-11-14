/** @jsxImportSource hono/jsx */
import { BRAND_FILES } from '@openparley/brand';
import { emailSchema, hashToken, randomToken, RateLimiter } from '@openparley/sync';
import { Hono, type Context } from 'hono';
import { getConnInfo } from 'hono/bun';
import { getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import type { Cloud } from './cloud';
import { urlFor, type CloudConfig } from './config';
import { slugFrom, slugProblem, type Signup, type Tenant } from './control';
import type { Account } from './accounts';
import { freeSlug } from './billing';
import { isPaidPlanId, isPlanId, PAID_PLANS, planLimits, PLANS, TRIAL_DAYS, type PaidPlanId, type PlanId } from './plans';
import { verifyWebhook, WebhookVerificationError, type PolarClient } from './polar';
import { Message, Page } from './views';
import { accountRoutes, safeNext, WorkspacesPage, type AccountEnv } from './account-routes';
import { brokerRoutes } from './mcp-broker';

const SIGNUP_COOKIE = 'openparley_signup';
/** How long a slug stays reserved if Polar doesn't tell us when the checkout expires. */
const RESERVATION_MS = 60 * 60 * 1000;
/** How long a free sign-up's confirmation link works (and holds the address). */
const CONFIRM_MS = 24 * 60 * 60 * 1000;

type Env = AccountEnv;

interface Options {
  cloud: Cloud;
  config: CloudConfig;
  /** Null when Polar isn't configured: sign-up is closed. */
  polar: PolarClient | null;
}

interface SignupValues {
  name: string;
  /** Empty: follows the name. */
  slug: string;
  email: string;
  plan: PlanId;
  /** Where to go once the workspace exists (an agent's sign-in waiting for it). */
  next: string;
}

/** cloud.<domain>: sign-up, the post-checkout page, the billing portal link, and Polar's webhook. */
export function controlPlane({ cloud, config, polar }: Options) {
  const app = new Hono<Env>();
  const base = urlFor(config, `cloud.${config.domain}`);
  const secure = config.scheme === 'https';
  const signupLimiter = new RateLimiter(20, 60 * 60 * 1000);
  // Renewal emails go to someone else's inbox (and count against the mail quota): keep them rare.
  const renewalPerWorkspace = new RateLimiter(3, 60 * 60 * 1000);
  const renewalPerIp = new RateLimiter(10, 60 * 60 * 1000);
  // Chrome applies form-action to the redirect after a form post, i.e. to Polar's checkout page.
  // A plain-http Polar only exists in development (the fake Polar server).
  const polarHttp = config.polar?.apiUrl.startsWith('http:') ? ` ${new URL(config.polar.apiUrl).origin}` : '';
  // Confirming a free sign-up redirects to the new workspace's setup page.
  const workspaces = urlFor(config, `*.${config.domain}`);

  app.get('/health', (c) => c.json({ ok: true, ...cloud.stats() }));

  app.get('/brand/:file', async (c) => {
    const path = BRAND_FILES[c.req.param('file')];
    if (!path) return c.notFound();
    const file = Bun.file(path);
    return c.body(await file.arrayBuffer(), 200, { 'content-type': file.type, 'cache-control': 'public, max-age=86400' });
  });
  app.get('/favicon.ico', (c) => c.redirect('/brand/favicon.svg', 301));

  // Server-to-server: authenticated by its signature, not by cookies, so outside the CSRF check.
  app.post('/webhooks/polar', async (c) => {
    if (!config.polar) return c.notFound();
    const body = await c.req.text();
    let event;
    try {
      event = verifyWebhook(body, c.req.raw.headers, config.polar.webhookSecret);
    } catch (error) {
      if (error instanceof WebhookVerificationError) return c.text(error.message, 403);
      return c.text('Malformed payload.', 400);
    }
    const outcome = await cloud.billing.handle(c.req.header('webhook-id')!, event, body);
    return c.json({ ok: true, outcome }, 202);
  });

  // Agents call the shared MCP URL's token endpoints without cookies or a browser Origin.
  const broker = brokerRoutes(cloud);
  broker.api(app, (c) => clientIp(c, config.trustProxy));

  app.use('*', csrf({ origin: [base, urlFor(config, config.domain)] }));
  app.use('*', async (c, next) => {
    c.set('nonce', randomToken(16));
    await next();
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    c.header(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; script-src 'nonce-${c.get('nonce')}'; connect-src 'self'; form-action 'self' ${workspaces} https:${polarHttp}; frame-ancestors 'none'; base-uri 'none'`,
    );
  });

  accountRoutes(app, { cloud, config, base, clientIp: (c) => clientIp(c, config.trustProxy) });
  broker.browser(app, config.siteUrl);

  app.get('/', (c) => {
    const account = c.get('account');
    if (account) return c.html(<WorkspacesPage account={account} cloud={cloud} siteUrl={config.siteUrl} />);
    return c.html(
      <Page
        title="OpenParley Cloud"
        siteUrl={config.siteUrl}
        aside={
          <a class="button secondary" style="margin:0" href="/login">
            Sign in
          </a>
        }
      >
        <h1>OpenParley Cloud</h1>
        <p>Comment on any element of your live site. Your product team replies in the thread, and your coding agent picks it up, ships the fix and replies too. We run the server; you add one script tag.</p>
        {polar ? (
          <div class="plans">
            {Object.values(PLANS).map((plan) => (
              <section>
                <h2>{plan.name}</h2>
                <p class="price">{plan.price}</p>
                <p class="muted">{plan.summary}</p>
                <a class="button" href={`/signup?plan=${plan.id}`}>
                  {plan.id === 'free' ? 'Start for free' : `Start with ${plan.name}`}
                </a>
              </section>
            ))}
          </div>
        ) : (
          <p class="muted">Sign-up is not open yet.</p>
        )}
        <p class="muted">
          Already a customer? <a href="/login">Sign in</a> or <a href="/billing">manage billing</a>.
        </p>
      </Page>,
    );
  });

  /** The next free address for a name: free of workspaces, reserved names and other browsers' open checkouts. */
  const addressFor = (name: string, browserHash: string | null) =>
    freeSlug(slugFrom(name), (slug) => !slugProblem(slug) && cloud.control.slugAvailable(slug, browserHash));
  const browserHashOf = (c: Context) => {
    const token = getCookie(c, SIGNUP_COOKIE);
    return token ? hashToken(token) : null;
  };

  app.get('/signup/address', (c) => c.json({ slug: addressFor(c.req.query('name') ?? '', browserHashOf(c)), domain: config.domain }));

  app.get('/signup', (c) => {
    if (!polar) return c.html(<Closed />, 503);
    const plan = c.req.query('plan');
    const account = c.get('account');
    const next = c.req.query('next') ? safeNext(c.req.query('next')) : '';
    // A GitHub account's username is the first suggestion: a solo developer's workspace is often just theirs.
    const name = account?.githubLogin ?? '';
    const values = { name, slug: '', email: account?.email ?? '', plan: isPlanId(plan) ? plan : 'free', next };
    return c.html(
      <SignupPage
        nonce={c.get('nonce')}
        domain={config.domain}
        siteUrl={config.siteUrl}
        values={values}
        preview={name ? addressFor(name, browserHashOf(c)) : ''}
        account={account}
        githubUrl={config.github && !account ? `/auth/github?${new URLSearchParams({ next: `/signup?${new URLSearchParams({ plan: values.plan, ...(next && { next }) })}` })}` : null}
      />,
    );
  });

  app.post('/signup', async (c) => {
    if (!polar || !config.polar) return c.html(<Closed />, 503);
    const form = await c.req.parseBody();
    const account = c.get('account');
    const values: SignupValues = {
      name: String(form.name ?? '').trim().slice(0, 80),
      slug: String(form.slug ?? '').trim().toLowerCase(),
      // Signed in: the account's address, which the sign-in already confirmed.
      email: account ? account.email : String(form.email ?? '').trim(),
      plan: isPlanId(form.plan) ? form.plan : 'free',
      next: form.next ? safeNext(String(form.next)) : '',
    };
    const fail = (error: string, status: 400 | 429 | 502 = 400) =>
      c.html(<SignupPage nonce={c.get('nonce')} domain={config.domain} siteUrl={config.siteUrl} values={values} preview={values.slug} account={account} githubUrl={null} error={error} />, status);

    const ip = clientIp(c, config.trustProxy);
    if (signupLimiter.blocked(ip)) return fail('Too many sign-ups from your network. Try again in an hour.', 429);
    signupLimiter.fail(ip);

    if (!values.name) return fail('Give your workspace a name.');
    // One cookie per browser, so going back from the checkout and trying again keeps the reservation.
    const browserToken = getCookie(c, SIGNUP_COOKIE) ?? randomToken();
    const browserHash = hashToken(browserToken);
    // No address chosen: the name's, with a suffix if that's taken. A chosen one is checked as typed.
    if (!values.slug) values.slug = addressFor(values.name, browserHash);
    const slugError = slugProblem(values.slug);
    if (slugError) return fail(`Workspace address: ${slugError}`);
    const email = emailSchema.safeParse(values.email);
    if (!email.success) return fail(email.error.issues[0]!.message);
    if (!cloud.control.slugAvailable(values.slug, browserHash)) return fail(`${values.slug}.${config.domain} is already taken. Pick another address.`);

    const remember = () => setCookie(c, SIGNUP_COOKIE, browserToken, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: 7 * 24 * 60 * 60 });

    // Signed in and free: nothing to confirm or pay, so the workspace exists right away, with this account as owner.
    if (account && values.plan === 'free') {
      const { tenant } = cloud.provision({ slug: values.slug, name: values.name, plan: 'free', ...planLimits(PLANS.free), billingEmail: account.email, verifiedOwnerEmail: account.email });
      cloud.createOwner(tenant, account);
      await ensurePolarCustomer(tenant, account.email);
      return c.redirect(values.next || `/open/${tenant.id}`, 303);
    }

    // Free: no payment, so the emailed link is what proves the address before anything is created.
    if (values.plan === 'free') {
      const signup = cloud.control.createSignup({ name: values.name, slug: values.slug, plan: values.plan, email: email.data, browserHash, expiresAt: Date.now() + CONFIRM_MS });
      try {
        await cloud.billing.sendSignupConfirmation(signup);
      } catch (error) {
        console.error(error);
        cloud.control.setSignupExpiry(signup.id, 0);
        return fail("We couldn't send the confirmation email. Please try again in a minute.", 502);
      }
      remember();
      return c.html(
        <Message title="Check your email">
          We've sent a link to {email.data}. Open it to create {values.name} at {values.slug}.{config.domain}. It works for 24 hours.
        </Message>,
      );
    }

    const signup = cloud.control.createSignup({
      name: values.name,
      slug: values.slug,
      plan: values.plan,
      email: email.data,
      browserHash,
      expiresAt: Date.now() + RESERVATION_MS,
      accountId: account?.id ?? null,
    });
    let checkout;
    try {
      checkout = await polar.createCheckout({
        productId: config.polar.products[values.plan],
        email: email.data,
        successUrl: `${base}/signup/done?signup=${signup.id}`,
        returnUrl: `${base}/signup?plan=${values.plan}`,
        metadata: { signup: signup.id, slug: values.slug },
      });
    } catch (error) {
      console.error(error);
      cloud.control.setSignupExpiry(signup.id, 0);
      return fail("We couldn't start the checkout. Please try again in a minute.", 502);
    }
    if (Number.isFinite(checkout.expiresAt)) cloud.control.setSignupExpiry(signup.id, checkout.expiresAt);
    remember();
    return c.redirect(checkout.url, 303);
  });

  // --- free sign-up confirmation -------------------------------------------
  // Opening the link changes nothing (mail scanners prefetch links); only the button below does.

  const freeSignup = (id: string | undefined) => {
    const signup = id ? cloud.control.findSignup(id) : null;
    if (!signup || signup.plan !== 'free') return null;
    if (!signup.tenantSlug && signup.expiresAt <= Date.now()) return null;
    return signup;
  };
  app.get('/signup/confirm', (c) => {
    const signup = freeSignup(c.req.query('signup'));
    if (!signup) return c.html(<ConfirmExpired />, 404);
    if (signup.tenantSlug) return c.html(<CreatedPage cloud={cloud} slug={signup.tenantSlug} />);
    return c.html(<ConfirmPage signup={signup} domain={config.domain} />);
  });

  app.post('/signup/confirm', async (c) => {
    const form = await c.req.parseBody();
    const signup = freeSignup(String(form.signup ?? ''));
    if (!signup) return c.html(<ConfirmExpired />, 404);
    if (signup.tenantSlug) return c.html(<CreatedPage cloud={cloud} slug={signup.tenantSlug} />);
    const { tenant, setupUrl } = cloud.provision({
      // The address was reserved for this sign-up, but an operator may have created it by hand since.
      slug: freeSlug(signup.slug, (slug) => !cloud.control.find(slug)),
      name: signup.name,
      plan: 'free',
      ...planLimits(PLANS.free),
      billingEmail: signup.email,
      // The link that got them here was sent to this address.
      verifiedOwnerEmail: signup.email,
    });
    cloud.control.completeSignup(signup.id, tenant.slug);
    await ensurePolarCustomer(tenant, signup.email);
    return c.redirect(setupUrl, 303);
  });

  /** Best effort: free workspaces appear in Polar, and a later upgrade checks out as this customer. */
  async function ensurePolarCustomer(tenant: Tenant, email: string) {
    if (!polar) return;
    try {
      const customerId = await polar.ensureCustomer({ email, name: tenant.name, metadata: { workspace: tenant.id } });
      cloud.control.update(tenant.slug, { polarCustomerId: customerId });
    } catch (error) {
      console.error(`Couldn't create a Polar customer for ${tenant.slug}:`, error);
    }
  }

  app.get('/signup/done', (c) => {
    const signup = cloud.control.findSignup(c.req.query('signup') ?? '');
    if (!signup) return c.html(<Message title="Sign-up not found">This link doesn't belong to a sign-up. Start again from the sign-up page.</Message>, 404);
    const cookie = getCookie(c, SIGNUP_COOKIE);
    // The setup link creates the owner account, so only the browser that signed up gets to see it.
    if (!cookie || hashToken(cookie) !== signup.browserHash) {
      return c.html(<Message title="Payment received">We've emailed the link to set up your workspace to the address you signed up with.</Message>);
    }
    return c.html(<DonePage signup={signup} cloud={cloud} />);
  });

  // --- workspace pages ------------------------------------------------------
  // A free workspace's admin page links here, and a paused workspace's pages redirect here.
  // Whoever reads the billing email can upgrade a free workspace: the same identity Polar's
  // customer portal uses, so the control plane needs no accounts of its own.

  /** Only free workspaces are sold an upgrade; a paused one was paused by an operator, and paying doesn't undo that. */
  const checkoutAllowed = (tenant: Tenant) => tenant.status === 'active' && tenant.plan === 'free';
  const workspacePage = (tenant: Tenant, extra: { renewing?: boolean; flash?: Flash } = {}) => (
    <WorkspacePage
      tenant={tenant}
      cloud={cloud}
      canRenew={!!polar && !!tenant.billingEmail}
      membersUsed={tenant.status === 'active' && tenant.plan === 'free' ? cloud.membersUsed(tenant.slug) : null}
      supportEmail={config.supportEmail}
      {...extra}
    />
  );

  app.get('/workspaces/:slug', (c) => {
    const tenant = cloud.control.find(c.req.param('slug'));
    if (!tenant) return c.html(<Message title="No such workspace">There is no OpenParley workspace with that address.</Message>, 404);
    return c.html(workspacePage(tenant, { renewing: c.req.query('renewing') === '1' }));
  });

  app.post('/workspaces/:slug/renewal-link', async (c) => {
    const tenant = cloud.control.find(c.req.param('slug'));
    if (!tenant) return c.html(<Message title="No such workspace">There is no OpenParley workspace with that address.</Message>, 404);
    const page = (flash: Flash, status: 200 | 400 | 429 | 502 = 200) => c.html(workspacePage(tenant, { flash }), status);
    if (!checkoutAllowed(tenant) || !polar || !tenant.billingEmail) return c.redirect(`/workspaces/${tenant.slug}`, 303);
    const ip = clientIp(c, config.trustProxy);
    if (renewalPerWorkspace.blocked(tenant.slug) || renewalPerIp.blocked(ip)) {
      return page({ error: 'A link was sent several times already. Check the inbox (and spam folder), or try again in an hour.' }, 429);
    }
    renewalPerWorkspace.fail(tenant.slug);
    renewalPerIp.fail(ip);
    try {
      await cloud.billing.sendRenewalLink(tenant);
    } catch (error) {
      console.error(error);
      return page({ error: "We couldn't send the email. Please try again in a minute." }, 502);
    }
    return page({ sent: maskEmail(tenant.billingEmail) });
  });

  /** Opening the link changes nothing (mail scanners prefetch links); only the form below does. */
  app.get('/renew', (c) => {
    const found = renewalFor(c.req.query('token'));
    if ('error' in found) return c.html(found.error, 404);
    const { tenant, token } = found;
    if (!checkoutAllowed(tenant)) return c.redirect(`/workspaces/${tenant.slug}`, 303);
    return c.html(<RenewPage tenant={tenant} token={token} viaPortal={renewsInPortal(tenant)} />);
  });

  app.post('/renew', async (c) => {
    const form = await c.req.parseBody();
    const found = renewalFor(String(form.token ?? ''));
    if ('error' in found) return c.html(found.error, 404);
    const { tenant, token } = found;
    if (!checkoutAllowed(tenant) || !polar || !config.polar) return c.redirect(`/workspaces/${tenant.slug}`, 303);
    const plan: PaidPlanId = isPaidPlanId(form.plan) ? form.plan : isPaidPlanId(tenant.plan) ? tenant.plan : 'team';
    try {
      if (renewsInPortal(tenant)) return c.redirect(await polar.portalUrl(tenant.polarCustomerId!, `${base}/workspaces/${tenant.slug}`), 303);
      const checkout = await polar.createCheckout({
        productId: config.polar.products[plan],
        email: tenant.billingEmail!,
        customerId: tenant.polarCustomerId,
        successUrl: `${base}/workspaces/${tenant.slug}?renewing=1`,
        returnUrl: `${base}/workspaces/${tenant.slug}`,
        metadata: { renew: tenant.id },
        // One trial per workspace: a team that cancelled and comes back pays from day one.
        allowTrial: !tenant.polarSubscriptionId,
      });
      return c.redirect(checkout.url, 303);
    } catch (error) {
      console.error(error);
      return c.html(<RenewPage tenant={tenant} token={token} viaPortal={renewsInPortal(tenant)} plan={plan} error="We couldn't reach our payment provider. Please try again in a minute." />, 502);
    }
  });

  function renewalFor(token: string | undefined): { tenant: Tenant; token: string } | { error: ReturnType<typeof Message> } {
    const slug = token ? cloud.control.renewalSlug(token) : null;
    const tenant = slug ? cloud.control.find(slug) : null;
    if (!token || !tenant) {
      return { error: <Message title="Link expired">This renewal link is invalid or has expired. Open your workspace's address to get a new one.</Message> };
    }
    return { tenant, token };
  }

  /** A paused (not ended) Polar subscription is resumed in Polar's portal; an ended one needs a new checkout. */
  function renewsInPortal(tenant: Tenant): boolean {
    const sub = tenant.polarSubscriptionId ? cloud.control.findSubscription(tenant.polarSubscriptionId) : null;
    return !!tenant.polarCustomerId && (sub?.status === 'paused' || sub?.status === 'unpaid');
  }

  app.get('/billing', (c) => {
    if (config.polar) return c.redirect(config.polar.portalUrl);
    return c.html(<Message title="Billing">There is no billing to manage yet.</Message>);
  });

  app.notFound((c) => c.html(<Message title="Not found">There is nothing here.</Message>, 404));

  return app;
}

/** Enough to recognise your own address, not enough to harvest someone else's. */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// --- views -----------------------------------------------------------------

function Closed() {
  return <Message title="Sign-up is not open yet">OpenParley Cloud isn't taking new workspaces yet. You can self-host OpenParley Sync today.</Message>;
}

// The address line follows the name (asking the server for the next free address) until someone types one.
const SLUG_SCRIPT = `(() => {
  const name = document.getElementById('name');
  const slug = document.getElementById('slug');
  const preview = document.getElementById('address');
  let timer;
  const show = (value) => { preview.textContent = value; };
  slug.addEventListener('input', () => { if (slug.value) show(slug.value); });
  name.addEventListener('input', () => {
    if (slug.value) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!name.value.trim()) return show('…');
      const res = await fetch('/signup/address?name=' + encodeURIComponent(name.value));
      if (res.ok && !slug.value) show((await res.json()).slug);
    }, 250);
  });
})();`;

function SignupPage(props: {
  nonce: string;
  domain: string;
  siteUrl: string | null;
  values: SignupValues;
  /** The address the name currently gives. */
  preview: string;
  account: Account | null;
  /** "Continue with GitHub" for people who aren't signed in. */
  githubUrl: string | null;
  error?: string;
}) {
  const { nonce, domain, siteUrl, values, preview, account, githubUrl, error } = props;
  return (
    <Page title="Start your workspace" siteUrl={siteUrl} aside={account ? <span class="muted">{account.githubLogin ?? account.email}</span> : undefined}>
      <h1>Start your OpenParley workspace</h1>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {account && (
        <p class="ok">
          Signed in as <strong>{account.githubLogin ?? account.email}</strong>
          {account.githubLogin ? ` (${account.email})` : ''}. No password and no confirmation email needed.
        </p>
      )}
      {githubUrl && (
        <div class="box">
          <a class="button github" style="margin:0" href={githubUrl}>
            Continue with GitHub
          </a>
          <p class="muted" style="margin:8px 0 0">
            We read your name, verified email and public profile. Nothing from your repositories.
          </p>
        </div>
      )}
      {githubUrl && <p class="or">or with your email</p>}
      <form method="post" action="/signup" class="box">
        {values.next && <input type="hidden" name="next" value={values.next} />}
        <label for="name">Company or project name</label>
        <input id="name" name="name" required maxlength={80} autocomplete="organization" placeholder="Acme" value={values.name} />
        <details class="address-choice" open={!!values.slug}>
          <summary>
            Your address: <strong id="address">{values.slug || preview || '…'}</strong>
            <strong>.{domain}</strong> · <span class="change">Change</span>
          </summary>
          <label for="slug">Address</label>
          <div class="address">
            <input id="slug" name="slug" maxlength={32} pattern="[a-z0-9](?:[a-z0-9\-]{0,30}[a-z0-9])?" placeholder={preview || 'acme'} value={values.slug} />
            <span class="muted">.{domain}</span>
          </div>
          <p class="muted" style="margin:4px 0 0">
            Letters, digits and dashes. It's in your script tag and your agents' settings, so pick one you'll keep. Leave it empty to follow the name.
          </p>
        </details>
        {!account && (
          <>
            <label for="email">Your email</label>
            <input id="email" name="email" type="email" required autocomplete="email" value={values.email} />
          </>
        )}
        <fieldset>
          <legend>Plan</legend>
          {Object.values(PLANS).map((plan) => (
            <label class="choice">
              <input type="radio" name="plan" value={plan.id} checked={values.plan === plan.id} /> {plan.name}, {plan.price}. {plan.summary}
            </label>
          ))}
        </fieldset>
        {siteUrl && (
          <p class="muted">
            By continuing, you agree to the <a href={`${siteUrl}/terms`}>terms of service</a> and the{' '}
            <a href={`${siteUrl}/dpa`}>data processing agreement</a>, for the organization the workspace is for. The{' '}
            <a href={`${siteUrl}/privacy`}>privacy policy</a> explains what we do with your details.
          </p>
        )}
        <button type="submit">{account ? 'Create workspace' : 'Continue'}</button>
      </form>
      <p class="muted">
        {account
          ? `Free: your workspace is ready right away. ${PLANS.team.name}: you start the ${TRIAL_DAYS}-day trial through Polar, our merchant of record.`
          : `Free: we email you a link to confirm your address and create the workspace. ${PLANS.team.name}: you start the ${TRIAL_DAYS}-day trial through Polar, our merchant of record, and then get a link to create your owner account, on screen and by email.`}
      </p>
      {!account && (
        <p class="muted">
          Already have an account? <a href="/login">Sign in</a>.
        </p>
      )}
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: SLUG_SCRIPT }} />
    </Page>
  );
}

function DonePage({ signup, cloud }: { signup: Signup; cloud: Cloud }) {
  const tenant = signup.tenantSlug ? cloud.control.find(signup.tenantSlug) : null;
  if (!tenant) {
    return (
      <Page title="Setting up your workspace" head={<meta http-equiv="refresh" content="2" />}>
        <h1>Setting up your workspace…</h1>
        <p>Thanks for subscribing. This page refreshes on its own when {signup.name} is ready, usually within seconds.</p>
        <p class="muted">We'll also email the setup link to {signup.email}.</p>
      </Page>
    );
  }
  const workspace = cloud.workspaceUrl(tenant.slug);
  if (signup.accountId) {
    return (
      <Page title="Your workspace is ready">
        <h1>Your workspace is ready</h1>
        <p>
          <strong>{tenant.name}</strong> lives at <code>{workspace}</code>.
        </p>
        <a class="button" href={`/open/${tenant.id}`}>
          Open {tenant.name}
        </a>
      </Page>
    );
  }
  if (cloud.hasOwner(tenant.slug)) {
    return (
      <Message title="Your workspace is ready">
        Sign in at <a href={`${workspace}/admin`}>{workspace}</a>.
      </Message>
    );
  }
  return (
    <Page title="Your workspace is ready">
      <h1>Your workspace is ready</h1>
      <p>
        <strong>{tenant.name}</strong> lives at <code>{workspace}</code>.
        {tenant.slug !== signup.slug && ` (${signup.slug} was taken while you were paying, so we picked the closest free address.)`}
      </p>
      <a class="button" href={cloud.setupUrl(tenant)}>
        Create your owner account
      </a>
      <p class="muted">This link works once. We've also emailed it to {signup.email}.</p>
    </Page>
  );
}

function ConfirmPage({ signup, domain }: { signup: Signup; domain: string }) {
  return (
    <Page title="Create your workspace">
      <h1>Create {signup.name}</h1>
      <form method="post" action="/signup/confirm" class="box">
        <input type="hidden" name="signup" value={signup.id} />
        <p style="margin:0">
          Your address is confirmed. Your free workspace will live at <code>{signup.slug}.{domain}</code>: for you and your coding agents,
          with unlimited threads.
        </p>
        <button type="submit">Create workspace</button>
      </form>
      <p class="muted">Next you create your owner account and add your site.</p>
    </Page>
  );
}

function ConfirmExpired() {
  return <Message title="Link expired">This confirmation link is invalid or has expired. Sign up again to get a new one.</Message>;
}

/** A confirmation link opened again after the workspace exists. */
function CreatedPage({ cloud, slug }: { cloud: Cloud; slug: string }) {
  const tenant = cloud.control.find(slug);
  const workspace = cloud.workspaceUrl(slug);
  if (!tenant || cloud.hasOwner(slug)) {
    return (
      <Message title="Your workspace is ready">
        Sign in at <a href={`${workspace}/admin`}>{workspace}</a>.
      </Message>
    );
  }
  return (
    <Page title="Your workspace is ready">
      <h1>Your workspace is ready</h1>
      <p>
        <strong>{tenant.name}</strong> lives at <code>{workspace}</code>.
      </p>
      <a class="button" href={cloud.setupUrl(tenant)}>
        Create your owner account
      </a>
    </Page>
  );
}

type Flash = { error: string } | { sent: string };

function WorkspacePage(props: {
  tenant: Tenant;
  cloud: Cloud;
  canRenew: boolean;
  /** Set for active free workspaces. */
  membersUsed: number | null;
  supportEmail: string | null;
  renewing?: boolean;
  flash?: Flash;
}) {
  const { tenant, cloud, canRenew, membersUsed, supportEmail, renewing, flash } = props;
  const workspace = cloud.workspaceUrl(tenant.slug);
  if (tenant.status === 'active' && membersUsed !== null) {
    if (renewing) {
      return (
        <Page title="Upgrading" head={<meta http-equiv="refresh" content="2" />}>
          <h1>Upgrading {tenant.name}…</h1>
          <p>Thanks. This page refreshes on its own when the upgrade is through, usually within seconds.</p>
        </Page>
      );
    }
    const over = membersUsed > (tenant.maxMembers ?? Infinity);
    const trial = !tenant.polarSubscriptionId;
    return (
      <Page title={`${tenant.name} is on the free plan`}>
        <h1>{tenant.name} is on the free plan</h1>
        {tenant.polarSubscriptionId && <p>Its {PLANS.team.name} subscription has ended. Nothing was deleted.</p>}
        <p>
          Free is for one person and their coding agents, with unlimited threads. To invite your team to <code>{workspace}</code>, upgrade to{' '}
          {PLANS.team.name}.
          {over && ` It has ${membersUsed} members now, so nobody can start a new thread until it upgrades; replies and everything else still work.`}
        </p>
        <FlashBox flash={flash} />
        {flash && 'sent' in flash ? null : canRenew ? (
          <form method="post" action={`/workspaces/${tenant.slug}/renewal-link`} class="box">
            <p style="margin:0">
              <strong>{PLANS.team.name}</strong>, {trial ? `free for ${TRIAL_DAYS} days, then ${PLANS.team.price}` : PLANS.team.price}. Unlimited
              members, threads and projects. We'll email a payment link to whoever handles billing.
            </p>
            <button type="submit">Email an upgrade link to {maskEmail(tenant.billingEmail!)}</button>
          </form>
        ) : null}
        <SupportLine supportEmail={supportEmail} canRenew={canRenew} action="upgrade it" />
      </Page>
    );
  }
  if (tenant.status === 'active') {
    return (
      <Message title={`${tenant.name} is active`}>
        Open it at <a href={`${workspace}/admin`}>{workspace}</a>.
      </Message>
    );
  }
  return (
    <Page title={`${tenant.name} is paused`}>
      <h1>{tenant.name} is paused</h1>
      <p>
        The workspace at <code>{workspace}</code> is paused. Its threads, projects and members are kept.
      </p>
      <SupportLine supportEmail={supportEmail} canRenew={false} action="reactivate it" />
    </Page>
  );
}

function FlashBox({ flash }: { flash?: Flash }) {
  if (!flash) return null;
  if ('error' in flash) {
    return (
      <p class="error" role="alert">
        {flash.error}
      </p>
    );
  }
  return (
    <p class="ok" role="status">
      We've emailed a link to {flash.sent}. It works for 24 hours.
    </p>
  );
}

function SupportLine({ supportEmail, canRenew, action }: { supportEmail: string | null; canRenew: boolean; action: string }) {
  return (
    <p class="muted">
      {supportEmail ? (
        <>
          {canRenew ? "Don't have access to that inbox? " : `To ${action}, `}write to <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
        </>
      ) : (
        !canRenew && `Its owner can contact OpenParley to ${action}.`
      )}
    </p>
  );
}

function RenewPage({ tenant, token, viaPortal, plan, error }: { tenant: Tenant; token: string; viaPortal: boolean; plan?: PaidPlanId; error?: string }) {
  const selected = plan ?? (isPaidPlanId(tenant.plan) ? tenant.plan : 'team');
  const title = `Upgrade ${tenant.name}`;
  return (
    <Page title={title}>
      <h1>{title}</h1>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <form method="post" action="/renew" class="box">
        <input type="hidden" name="token" value={token} />
        {viaPortal ? (
          <p style="margin:0">The subscription is paused, not ended. Resume it in the billing portal and the workspace is back on its paid plan right away.</p>
        ) : (
          <PaidPlanChoice selected={selected} />
        )}
        <button type="submit">{viaPortal ? 'Open the billing portal' : 'Continue to payment'}</button>
      </form>
      <p class="muted">Everything in the workspace stays as it is.</p>
    </Page>
  );
}

function PaidPlanChoice({ selected }: { selected: PaidPlanId }) {
  if (PAID_PLANS.length === 1) {
    const plan = PLANS[PAID_PLANS[0]!];
    return (
      <p style="margin:0">
        <input type="hidden" name="plan" value={plan.id} />
        <strong>{plan.name}</strong>, {plan.price}. {plan.summary}
      </p>
    );
  }
  return (
    <fieldset style="margin:0">
      <legend>Plan</legend>
      {PAID_PLANS.map((id) => (
        <label class="choice">
          <input type="radio" name="plan" value={id} checked={selected === id} /> {PLANS[id].name}, {PLANS[id].price}. {PLANS[id].summary}
        </label>
      ))}
    </fieldset>
  );
}
