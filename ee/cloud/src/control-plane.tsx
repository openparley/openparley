/** @jsxImportSource hono/jsx */
import { BRAND_FILES, brandFontsCss } from '@openparley/brand';
import { emailSchema, hashToken, randomToken, RateLimiter } from '@openparley/sync';
import { Hono, type Context } from 'hono';
import { getConnInfo } from 'hono/bun';
import { getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import type { Child } from 'hono/jsx';
import type { Cloud } from './cloud';
import { urlFor, type CloudConfig } from './config';
import { slugProblem, type Signup, type Tenant } from './control';
import { freeSlug } from './billing';
import { isPaidPlanId, isPlanId, PAID_PLANS, planLimits, PLANS, TRIAL_DAYS, type PaidPlanId, type PlanId } from './plans';
import { verifyWebhook, WebhookVerificationError, type PolarClient } from './polar';

const SIGNUP_COOKIE = 'openparley_signup';
/** How long a slug stays reserved if Polar doesn't tell us when the checkout expires. */
const RESERVATION_MS = 60 * 60 * 1000;
/** How long a free sign-up's confirmation link works (and holds the address). */
const CONFIRM_MS = 24 * 60 * 60 * 1000;

type Env = { Variables: { nonce: string } };

interface Options {
  cloud: Cloud;
  config: CloudConfig;
  /** Null when Polar isn't configured: sign-up is closed. */
  polar: PolarClient | null;
}

interface SignupValues {
  name: string;
  slug: string;
  email: string;
  plan: PlanId;
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
      `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; script-src 'nonce-${c.get('nonce')}'; form-action 'self' ${workspaces} https:${polarHttp}; frame-ancestors 'none'; base-uri 'none'`,
    );
  });

  app.get('/', (c) =>
    c.html(
      <Page title="OpenParley Cloud">
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
          Already a customer? <a href="/billing">Manage billing</a>.
        </p>
      </Page>,
    ),
  );

  app.get('/signup', (c) => {
    if (!polar) return c.html(<Closed />, 503);
    const plan = c.req.query('plan');
    return c.html(<SignupPage nonce={c.get('nonce')} domain={config.domain} values={{ name: '', slug: '', email: '', plan: isPlanId(plan) ? plan : 'free' }} />);
  });

  app.post('/signup', async (c) => {
    if (!polar || !config.polar) return c.html(<Closed />, 503);
    const form = await c.req.parseBody();
    const values: SignupValues = {
      name: String(form.name ?? '').trim().slice(0, 80),
      slug: String(form.slug ?? '').trim().toLowerCase(),
      email: String(form.email ?? '').trim(),
      plan: isPlanId(form.plan) ? form.plan : 'free',
    };
    const fail = (error: string, status: 400 | 429 | 502 = 400) =>
      c.html(<SignupPage nonce={c.get('nonce')} domain={config.domain} values={values} error={error} />, status);

    const ip = clientIp(c, config.trustProxy);
    if (signupLimiter.blocked(ip)) return fail('Too many sign-ups from your network. Try again in an hour.', 429);
    signupLimiter.fail(ip);

    if (!values.name) return fail('Give your workspace a name.');
    const slugError = slugProblem(values.slug);
    if (slugError) return fail(`Workspace address: ${slugError}`);
    const email = emailSchema.safeParse(values.email);
    if (!email.success) return fail(email.error.issues[0]!.message);

    // One cookie per browser, so going back from the checkout and trying again keeps the reservation.
    const browserToken = getCookie(c, SIGNUP_COOKIE) ?? randomToken();
    const browserHash = hashToken(browserToken);
    if (!cloud.control.slugAvailable(values.slug, browserHash)) return fail(`${values.slug}.${config.domain} is already taken. Pick another address.`);

    const remember = () => setCookie(c, SIGNUP_COOKIE, browserToken, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: 7 * 24 * 60 * 60 });

    // Free: no payment, so the emailed link is what proves the address before anything is created.
    if (values.plan === 'free') {
      const signup = cloud.control.createSignup({ ...values, email: email.data, browserHash, expiresAt: Date.now() + CONFIRM_MS });
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

    const signup = cloud.control.createSignup({ ...values, email: email.data, browserHash, expiresAt: Date.now() + RESERVATION_MS });
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
    });
    cloud.control.completeSignup(signup.id, tenant.slug);
    // Best effort: free workspaces appear in Polar, and a later upgrade checks out as this customer.
    if (polar) {
      try {
        const customerId = await polar.ensureCustomer({ email: signup.email, name: signup.name, metadata: { workspace: tenant.slug } });
        cloud.control.update(tenant.slug, { polarCustomerId: customerId });
      } catch (error) {
        console.error(`Couldn't create a Polar customer for ${tenant.slug}:`, error);
      }
    }
    return c.redirect(setupUrl, 303);
  });

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
        metadata: { renew: tenant.slug },
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

const STYLE = `${brandFontsCss()}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 'Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#14181f;background:#fbf7ee;accent-color:#2c7f6b}
.logo{display:block}.logo img{display:block;height:30px;width:auto}
main{max-width:760px;margin:0 auto;padding:32px 20px 64px}h1{font-size:24px;margin:0 0 16px}h2{font-size:18px;margin:0 0 4px}
a{color:#1f5a4c}code,pre{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f3ecdc;border-radius:4px;padding:1px 4px}
pre{padding:10px;white-space:pre-wrap;word-break:break-all}
section,.box{background:#fff;border:1px solid #e7dec9;border-radius:20px;padding:16px;margin:0 0 12px;box-shadow:0 8px 24px -8px rgb(90 67 16 / 0.08)}
label{display:block;font-weight:600;margin:12px 0 4px}input{font:inherit;width:100%;padding:8px 10px;border:1px solid #cfc3a8;border-radius:12px;background:#fff}
input:focus{outline:none;border-color:#2c7f6b;box-shadow:0 0 0 0.5px #2c7f6b}
button,.button{display:inline-block;font:inherit;font-weight:700;padding:8px 16px;border-radius:999px;border:1px solid #2c7f6b;background:#2c7f6b;color:#fff;cursor:pointer;margin-top:12px;text-decoration:none}
.muted{color:#5e6672}.error{background:#fbe6df;border:1px solid #e8846b;color:#14181f;padding:10px 12px;border-radius:12px}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:24px 0}.plans section{margin:0}.price{font-size:20px;font-weight:700;margin:0}
.address{display:flex;align-items:center;gap:6px}.address input{flex:1}.address span{white-space:nowrap}
fieldset{border:0;padding:0;margin:12px 0 0}legend{font-weight:600;margin-bottom:4px;padding:0}
.choice{display:flex;gap:8px;align-items:center;font-weight:400;margin:6px 0}.choice input{width:auto}
.ok{background:#ddf1ea;border:1px solid #7cc7b2;padding:10px 12px;border-radius:12px}
`;

function Page({ title, head, children }: { title: string; head?: Child; children: Child }) {
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
        {head}
      </head>
      <body>
        <main>
          <header>
            <a class="logo" href="/">
              <img src="/brand/logo-light.svg" alt="OpenParley" width="124" height="30" />
            </a>
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

function Closed() {
  return <Message title="Sign-up is not open yet">OpenParley Cloud isn't taking new workspaces yet. You can self-host OpenParley Sync today.</Message>;
}

// Fills in the address from the name until the person edits the address themselves.
const SLUG_SCRIPT = `(() => {
  const name = document.getElementById('name');
  const slug = document.getElementById('slug');
  let touched = slug.value !== '';
  slug.addEventListener('input', () => { touched = slug.value !== ''; });
  name.addEventListener('input', () => {
    if (touched) return;
    slug.value = name.value.toLowerCase().normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');
  });
})();`;

function SignupPage({ nonce, domain, values, error }: { nonce: string; domain: string; values: SignupValues; error?: string }) {
  return (
    <Page title="Start your workspace">
      <h1>Start your OpenParley workspace</h1>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <form method="post" action="/signup" class="box">
        <label for="name">Workspace name</label>
        <input id="name" name="name" required maxlength={80} autocomplete="organization" placeholder="Acme" value={values.name} />
        <label for="slug">Address</label>
        <div class="address">
          <input id="slug" name="slug" required maxlength={32} pattern="[a-z0-9](?:[a-z0-9\-]{0,30}[a-z0-9])?" placeholder="acme" value={values.slug} />
          <span class="muted">.{domain}</span>
        </div>
        <label for="email">Your email</label>
        <input id="email" name="email" type="email" required autocomplete="email" value={values.email} />
        <fieldset>
          <legend>Plan</legend>
          {Object.values(PLANS).map((plan) => (
            <label class="choice">
              <input type="radio" name="plan" value={plan.id} checked={values.plan === plan.id} /> {plan.name}, {plan.price}. {plan.summary}
            </label>
          ))}
        </fieldset>
        <button type="submit">Continue</button>
      </form>
      <p class="muted">
        Free: we email you a link to confirm your address and create the workspace. {PLANS.team.name}: you start the {TRIAL_DAYS}-day trial
        through Polar, our merchant of record, and then get a link to create your owner account, on screen and by email.
      </p>
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
