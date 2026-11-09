import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cloud } from '../src/cloud';
import { loadCloudConfig } from '../src/config';
import { ControlStore } from '../src/control';
import type { Mail } from '../src/mailer';
import { signWebhook, verifyWebhook, type PolarSubscription } from '../src/polar';

const DOMAIN = 'parley.test';
const CONTROL = `https://cloud.${DOMAIN}`;
const SECRET = `whsec_${Buffer.from('a test secret of thirty-two bytes').toString('base64')}`;
const PRODUCTS = { team: '11111111-1111-4111-8111-111111111111' };
const POLAR_ENV = {
  POLAR_ACCESS_TOKEN: 'polar_test_token',
  POLAR_WEBHOOK_SECRET: SECRET,
  POLAR_PRODUCT_TEAM: PRODUCTS.team,
  POLAR_ORG: 'openparley',
  POLAR_SERVER: 'sandbox',
};

const clouds: Cloud[] = [];
afterEach(() => {
  for (const cloud of clouds.splice(0)) cloud.close();
});

function setup(options: { env?: Record<string, string>; polarDown?: boolean; mailDown?: boolean; dataDir?: string } = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'openparley-billing-'));
  const config = { ...loadCloudConfig({ CLOUD_DOMAIN: DOMAIN, DATA_DIR: dataDir, ...POLAR_ENV, ...options.env }), overlayDir: '/nonexistent' };
  const mails: Mail[] = [];
  const checkouts: Array<{ url: string; auth: string | null; body: any }> = [];
  const sessions: string[] = [];
  const customers = new Map<string, { id: string; email: string; name: string; metadata: Record<string, string> }>();
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (options.polarDown) return new Response('down', { status: 503 });
    if (url.includes('/v1/customers/') && init?.method === 'GET') {
      const email = new URL(url).searchParams.get('email');
      return Response.json({ items: [...customers.values()].filter((c) => c.email === email) });
    }
    const body = JSON.parse(String(init?.body));
    if (url.endsWith('/v1/customers/')) {
      if (customers.has(body.email)) return Response.json({ detail: 'exists' }, { status: 422 });
      const customer = { id: `cust-${customers.size + 1}`, ...body };
      customers.set(body.email, customer);
      return Response.json(customer, { status: 201 });
    }
    if (url.endsWith('/v1/customer-sessions/')) {
      sessions.push(body.customer_id);
      return Response.json({ customer_portal_url: `https://sandbox.polar.sh/openparley/portal?session=${sessions.length}` });
    }
    checkouts.push({ url, auth: new Headers(init?.headers).get('authorization'), body });
    return Response.json({ id: `checkout-${checkouts.length}`, url: `https://sandbox.polar.sh/checkout/${checkouts.length}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  }) as typeof fetch;
  const send = async (mail: Mail) => {
    if (options.mailDown) throw new Error('mail is down');
    mails.push(mail);
  };
  const cloud = new Cloud(config, { mailer: { send }, fetch: fakeFetch });
  clouds.push(cloud);
  return { cloud, config, mails, checkouts, sessions, customers, dataDir };
}

/** A browser on cloud.<domain>: keeps its cookies, sends same-origin form posts. */
function browser(cloud: Cloud) {
  let cookie = '';
  const request = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    if (init.method === 'POST' && !headers.has('origin')) headers.set('origin', new URL(url).origin);
    const res = await cloud.fetch(new Request(url, { ...init, headers, redirect: 'manual' }));
    const set = res.headers.get('set-cookie');
    if (set && new URL(url).host === `cloud.${DOMAIN}`) cookie = set.split(';')[0]!;
    return res;
  };
  const post = (url: string, fields: Record<string, string>) =>
    request(url, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { request, post };
}

let deliveries = 0;
async function webhook(cloud: Cloud, type: string, data: unknown, options: { id?: string; secret?: string; at?: number; body?: string } = {}) {
  const id = options.id ?? `msg_${++deliveries}`;
  const timestamp = Math.floor((options.at ?? Date.now()) / 1000);
  const body = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  return cloud.fetch(
    new Request(`${CONTROL}/webhooks/polar`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signWebhook(options.secret ?? SECRET, id, timestamp, body),
      },
      body: options.body ?? body,
    }),
  );
}

const T0 = Date.parse('2026-11-01T10:00:00Z');
function subscription(signup: string, overrides: Partial<PolarSubscription> & { at?: number } = {}): PolarSubscription {
  const { at = T0, ...rest } = overrides;
  return {
    id: 'sub-1',
    status: 'active',
    created_at: new Date(T0).toISOString(),
    modified_at: new Date(at).toISOString(),
    customer_id: 'cust-1',
    product_id: PRODUCTS.team,
    metadata: { signup, slug: 'acme' },
    customer: { email: 'billing@acme.test' },
    ...rest,
  };
}

/** Fills in the sign-up form and follows it to the (fake) Polar checkout. Returns the sign-up id. */
async function signUp(b: ReturnType<typeof browser>, fields: Partial<Record<'name' | 'slug' | 'email' | 'plan', string>> = {}) {
  const res = await b.post(`${CONTROL}/signup`, { name: 'Acme', slug: 'acme', email: 'olivia@acme.test', plan: 'team', ...fields });
  expect(res.status).toBe(303);
  return res;
}

const signupIdOf = (checkout: { body: any }) => checkout.body.metadata.signup as string;

describe('webhook signatures', () => {
  test('accepts Polar-signed events and rejects everything else', async () => {
    const { cloud } = setup();
    expect((await webhook(cloud, 'order.paid', { id: 'o1' })).status).toBe(202);
    expect((await webhook(cloud, 'order.paid', { id: 'o1' }, { secret: 'whsec_c29tZXRoaW5nIGVsc2U=' })).status).toBe(403);
    expect((await webhook(cloud, 'order.paid', { id: 'o1' }, { body: JSON.stringify({ type: 'order.paid', data: { id: 'forged' } }) })).status).toBe(403);
    expect((await webhook(cloud, 'order.paid', { id: 'o1' }, { at: Date.now() - 10 * 60_000 })).status).toBe(403);
    const unsigned = await cloud.fetch(new Request(`${CONTROL}/webhooks/polar`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
    expect(unsigned.status).toBe(403);
  });

  test('also accepts secrets created before Standard Webhooks (keyed with the raw string)', () => {
    const body = JSON.stringify({ type: 'order.paid', timestamp: '', data: {} });
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const legacy = `v1,${createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(`m1.${ts}.${body}`).digest('base64')}`;
    const headers = new Headers({ 'webhook-id': 'm1', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,bogus ${legacy}` });
    expect(verifyWebhook(body, headers, SECRET, now).type).toBe('order.paid');
  });

  test('without Polar configured there is no webhook endpoint and sign-up is closed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openparley-billing-'));
    const cloud = new Cloud({ ...loadCloudConfig({ CLOUD_DOMAIN: DOMAIN, DATA_DIR: dataDir }), overlayDir: '/nonexistent' });
    clouds.push(cloud);
    expect((await cloud.fetch(new Request(`${CONTROL}/webhooks/polar`, { method: 'POST', body: '{}' }))).status).toBe(404);
    expect(await (await cloud.fetch(new Request(`${CONTROL}/`))).text()).toContain('Sign-up is not open yet');
    expect((await browser(cloud).post(`${CONTROL}/signup`, { name: 'A', slug: 'a', email: 'a@a.test', plan: 'team' })).status).toBe(503);
  });
});

describe('sign-up', () => {
  test('the terms, DPA and privacy policy are linked before signing up, and in every workspace', async () => {
    const { cloud } = setup({ env: { SITE_URL: 'https://openparley.test/' } });
    const page = await (await browser(cloud).request(`${CONTROL}/signup`)).text();
    const agreement = page.slice(page.indexOf('By continuing'), page.indexOf('type="submit"'));
    for (const path of ['/terms', '/dpa', '/privacy']) expect(agreement).toContain(`href="https://openparley.test${path}"`);
    expect(page).toContain('href="https://openparley.test/imprint"');

    cloud.provision({ slug: 'acme', name: 'Acme' });
    const token = cloud.control.find('acme')!.setupToken;
    const setupPage = await (await cloud.fetch(new Request(`https://acme.${DOMAIN}/setup?token=${token}`))).text();
    expect(setupPage).toContain('href="https://openparley.test/privacy"');
  });

  test('without SITE_URL (development) there are no legal links', async () => {
    const { cloud } = setup();
    expect(await (await browser(cloud).request(`${CONTROL}/signup`)).text()).not.toContain('By continuing');
  });

  test('form → checkout → webhook → setup link → owner account', async () => {
    const { cloud, mails, checkouts } = setup();
    const b = browser(cloud);
    expect(await (await b.request(`${CONTROL}/signup`)).text()).toContain('value="free" checked');
    expect(await (await b.request(`${CONTROL}/signup?plan=team`)).text()).toContain('value="team" checked');

    const res = await signUp(b);
    expect(res.headers.get('location')).toBe('https://sandbox.polar.sh/checkout/1');
    expect(checkouts[0]!.url).toBe('https://sandbox-api.polar.sh/v1/checkouts/');
    expect(checkouts[0]!.auth).toBe('Bearer polar_test_token');
    expect(checkouts[0]!.body).toMatchObject({ products: [PRODUCTS.team], customer_email: 'olivia@acme.test', metadata: { slug: 'acme' } });
    const signup = signupIdOf(checkouts[0]!);
    expect(checkouts[0]!.body.success_url).toBe(`${CONTROL}/signup/done?signup=${signup}`);

    // Back from Polar before the webhook has arrived: the page waits.
    const waiting = await b.request(`${CONTROL}/signup/done?signup=${signup}`);
    const waitingHtml = await waiting.text();
    expect(waitingHtml).toContain('Setting up your workspace');
    expect(waitingHtml).toContain('http-equiv="refresh"');

    // A checkout that hasn't been paid doesn't provision anything.
    await webhook(cloud, 'subscription.created', subscription(signup, { status: 'incomplete' }));
    expect(cloud.control.find('acme')).toBeNull();

    expect((await webhook(cloud, 'subscription.active', subscription(signup, { at: T0 + 1 }))).status).toBe(202);
    const tenant = cloud.control.find('acme')!;
    expect(tenant).toMatchObject({ name: 'Acme', status: 'active', plan: 'team', maxMembers: null, maxThreads: null, billingEmail: 'billing@acme.test', polarCustomerId: 'cust-1', polarSubscriptionId: 'sub-1' });
    const setupUrl = cloud.setupUrl(tenant);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('billing@acme.test');
    expect(mails[0]!.text).toContain(setupUrl);
    expect(mails[0]!.text).toContain('https://sandbox.polar.sh/openparley/portal');

    // The signing-up browser sees the setup link; anyone else with the URL doesn't.
    expect(await (await b.request(`${CONTROL}/signup/done?signup=${signup}`)).text()).toContain(setupUrl.replace(/&/g, '&amp;'));
    const stranger = await (await browser(cloud).request(`${CONTROL}/signup/done?signup=${signup}`)).text();
    expect(stranger).toContain('Payment received');
    expect(stranger).not.toContain(tenant.setupToken);

    // The link creates the owner, after which the page points to sign-in instead.
    const owner = await b.post(setupUrl.split('?')[0]!, { token: tenant.setupToken, name: 'Olivia', email: 'olivia@acme.test', password: 'correct horse battery' });
    expect(owner.status).toBe(302);
    const after = await (await b.request(`${CONTROL}/signup/done?signup=${signup}`)).text();
    expect(after).toContain('Sign in at');
    expect(after).not.toContain(tenant.setupToken);
  });

  test('validates the form and keeps a slug reserved while its checkout is open', async () => {
    const { cloud, checkouts } = setup();
    cloud.provision({ slug: 'taken', name: 'Taken' });
    const b = browser(cloud);
    for (const [fields, message] of [
      [{ slug: 'Not A Slug!' }, 'lowercase letters'],
      [{ slug: 'cloud' }, 'reserved'],
      [{ slug: 'taken' }, 'already taken'],
      [{ name: '' }, 'Give your workspace a name'],
      [{ email: 'nope' }, 'valid email'],
    ] as Array<[Record<string, string>, string]>) {
      const res = await b.post(`${CONTROL}/signup`, { name: 'Acme', slug: 'acme', email: 'o@acme.test', plan: 'team', ...fields });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(message);
    }
    expect(checkouts).toHaveLength(0);

    await signUp(b);
    // Someone else can't grab the address while the first checkout is open…
    const other = await browser(cloud).post(`${CONTROL}/signup`, { name: 'Acme 2', slug: 'acme', email: 'x@x.test', plan: 'team' });
    expect(other.status).toBe(400);
    // …but the same browser can go back and try again.
    await signUp(b);
    expect(checkouts).toHaveLength(2);
  });

  test('a failed checkout shows an error and releases the address', async () => {
    const { cloud } = setup({ polarDown: true });
    const res = await browser(cloud).post(`${CONTROL}/signup`, { name: 'Acme', slug: 'acme', email: 'o@acme.test', plan: 'team' });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("start the checkout");
    expect(cloud.control.slugAvailable('acme', null)).toBe(true);
  });

  test('if the address was taken while paying, the workspace gets the closest free one', async () => {
    const { cloud, checkouts } = setup();
    await signUp(browser(cloud));
    cloud.provision({ slug: 'acme', name: 'Someone else' });
    await webhook(cloud, 'subscription.active', subscription(signupIdOf(checkouts[0]!)));
    expect(cloud.control.findBySubscription('sub-1')!.slug).toBe('acme-2');
  });

  test('an active subscription without a sign-up is left for an operator', async () => {
    const { cloud, mails } = setup();
    const res = await webhook(cloud, 'subscription.active', subscription('unknown'));
    expect(res.status).toBe(202);
    expect(cloud.stats().workspaces).toBe(0);
    expect(mails).toHaveLength(0);
  });
});

describe('subscription lifecycle', () => {
  async function subscribed() {
    const ctx = setup({ env: { SUPPORT_EMAIL: 'help@parley.test' } });
    await signUp(browser(ctx.cloud));
    const signup = signupIdOf(ctx.checkouts[0]!);
    await webhook(ctx.cloud, 'subscription.active', subscription(signup));
    const plan = () => ctx.cloud.control.find('acme')!.plan;
    return { ...ctx, signup, plan };
  }
  const health = async (cloud: Cloud) => (await cloud.fetch(new Request(`https://acme.${DOMAIN}/health`))).status;

  test('a redelivered event is processed once', async () => {
    const { cloud, mails, checkouts } = setup();
    await signUp(browser(cloud));
    const data = subscription(signupIdOf(checkouts[0]!));
    for (let i = 0; i < 3; i++) expect((await webhook(cloud, 'subscription.active', data, { id: 'msg_same' })).status).toBe(202);
    // Different deliveries describing the same active subscription don't provision twice either.
    await webhook(cloud, 'subscription.updated', data);
    expect(cloud.stats().workspaces).toBe(1);
    expect(mails).toHaveLength(1);
    expect(cloud.control.eventCount()).toBe(2);
  });

  test('cancel at period end keeps Team; when the subscription ends the workspace drops to Free and keeps working', async () => {
    const { cloud, signup, plan, mails } = await subscribed();
    await webhook(cloud, 'subscription.canceled', subscription(signup, { cancel_at_period_end: true, at: T0 + 1000 } as any));
    expect(plan()).toBe('team');
    await webhook(cloud, 'subscription.revoked', subscription(signup, { status: 'canceled', at: T0 + 2000 }));
    expect(cloud.control.find('acme')).toMatchObject({ status: 'active', plan: 'free', maxMembers: 1, maxThreads: null, suspendedAt: null, polarSubscriptionId: 'sub-1' });
    expect(await health(cloud)).toBe(200);
    const mail = mails.at(-1)!;
    expect(mail).toMatchObject({ to: 'billing@acme.test', replyTo: 'help@parley.test', subject: 'Your OpenParley workspace Acme is now on the free plan' });
    expect(mail.text).toContain('Nothing is deleted');
    expect(mail.text).toContain(`${CONTROL}/renew?token=`);
    // Another event about the ended subscription doesn't email again.
    await webhook(cloud, 'subscription.updated', subscription(signup, { status: 'canceled', at: T0 + 3000 }));
    expect(mails.filter((m) => m.subject.includes('free plan'))).toHaveLength(1);
  });

  test('past due stays on Team (Polar retries payment); unpaid drops to Free; paying again restores Team', async () => {
    const { cloud, signup, plan, mails } = await subscribed();
    await webhook(cloud, 'subscription.past_due', subscription(signup, { status: 'past_due', at: T0 + 1000 }));
    expect(plan()).toBe('team');
    await webhook(cloud, 'subscription.updated', subscription(signup, { status: 'unpaid', at: T0 + 2000 }));
    expect(plan()).toBe('free');
    await webhook(cloud, 'subscription.updated', subscription(signup, { status: 'active', at: T0 + 3000 }));
    expect(cloud.control.find('acme')).toMatchObject({ plan: 'team', maxThreads: null });
    expect(mails.at(-1)!.subject).toBe('Acme is now on OpenParley Team');
  });

  test('a subscription event applies the plan\'s limits', async () => {
    const { cloud, signup } = await subscribed();
    // A paid plan lifts every limit it doesn't set, e.g. one an operator set by hand.
    cloud.control.update('acme', { maxThreads: 100, maxMembers: 3 });
    await webhook(cloud, 'subscription.updated', subscription(signup, { at: T0 + 500 }));
    expect(cloud.control.find('acme')).toMatchObject({ plan: 'team', maxMembers: null, maxThreads: null });
    // An unknown product (e.g. a retired price) keeps the current limits.
    cloud.control.update('acme', { maxMembers: 3 });
    await webhook(cloud, 'subscription.updated', subscription(signup, { product_id: 'something-else', at: T0 + 2000 }));
    expect(cloud.control.find('acme')).toMatchObject({ plan: 'team', maxMembers: 3 });
  });

  test('events arriving out of order never undo a newer state', async () => {
    const { cloud, signup, plan } = await subscribed();
    await webhook(cloud, 'subscription.revoked', subscription(signup, { status: 'canceled', at: T0 + 5000 }));
    await webhook(cloud, 'subscription.updated', subscription(signup, { status: 'active', at: T0 + 4000 }));
    expect(plan()).toBe('free');
  });

  test('billing never lifts an operator\'s pause', async () => {
    const { cloud, signup } = await subscribed();
    cloud.control.update('acme', { status: 'suspended' });
    await webhook(cloud, 'subscription.updated', subscription(signup, { at: T0 + 1000 }));
    await webhook(cloud, 'subscription.revoked', subscription(signup, { status: 'canceled', at: T0 + 2000 }));
    expect(cloud.control.find('acme')).toMatchObject({ status: 'suspended', plan: 'free' });
    expect(await health(cloud)).toBe(402);
  });

  test('a subscription that ended before its activation arrived is never provisioned', async () => {
    const { cloud, checkouts } = setup();
    await signUp(browser(cloud));
    const signup = signupIdOf(checkouts[0]!);
    await webhook(cloud, 'subscription.revoked', subscription(signup, { status: 'canceled', at: T0 + 5000 }));
    await webhook(cloud, 'subscription.active', subscription(signup, { at: T0 + 1000 }));
    expect(cloud.stats().workspaces).toBe(0);
  });
});

describe('after a subscription ends', () => {
  async function ended(polarStatus: PolarSubscription['status'] = 'canceled') {
    const ctx = setup({ env: { SUPPORT_EMAIL: 'help@parley.test' } });
    const b = browser(ctx.cloud);
    await signUp(b);
    const signup = signupIdOf(ctx.checkouts[0]!);
    await webhook(ctx.cloud, 'subscription.active', subscription(signup));
    await webhook(ctx.cloud, 'subscription.updated', subscription(signup, { status: polarStatus, at: T0 + 1000 }));
    expect(ctx.cloud.control.find('acme')!.plan).toBe('free');
    return { ...ctx, b, signup };
  }
  const linkIn = (text: string) => /(https:\/\/cloud\.parley\.test\/renew\?token=[\w-]+)/.exec(text)![1]!;

  test('the billing contact upgrades again as the same Polar customer; the old subscription no longer matters', async () => {
    const { cloud, b, mails, checkouts, signup } = await ended();
    const page = await (await b.request(`${CONTROL}/workspaces/acme`)).text();
    expect(page).toContain('Acme is on the free plan');
    expect(page).toContain('Team subscription has ended');
    // It had a subscription already, so no second free trial.
    expect(page).toContain('Team</strong>, $19/month');
    expect(page).toContain('Email an upgrade link to b•••@acme.test');
    expect(page).not.toContain('billing@acme.test');

    const sent = await b.post(`${CONTROL}/workspaces/acme/renewal-link`, {});
    expect(await sent.text()).toContain('emailed a link to b•••@acme.test');
    const mail = mails.at(-1)!;
    expect(mail).toMatchObject({ to: 'billing@acme.test', replyTo: 'help@parley.test', subject: 'Upgrade your OpenParley workspace Acme' });
    const link = linkIn(mail.text);

    // Opening the link (or a mail scanner prefetching it) changes nothing.
    expect(await (await b.request(link)).text()).toContain('name="plan" value="team"');
    expect(checkouts).toHaveLength(1);

    const token = new URL(link).searchParams.get('token')!;
    expect((await b.post(`${CONTROL}/renew`, { token, plan: 'team' })).status).toBe(303);
    expect(checkouts[1]!.body).toEqual({
      products: [PRODUCTS.team],
      customer_id: 'cust-1',
      success_url: `${CONTROL}/workspaces/acme?renewing=1`,
      return_url: `${CONTROL}/workspaces/acme`,
      metadata: { renew: 'acme' },
      allow_trial: false,
    });

    await webhook(cloud, 'subscription.active', subscription('', { id: 'sub-2', metadata: { renew: 'acme' }, at: T0 + 5000 }));
    expect(cloud.control.find('acme')).toMatchObject({ status: 'active', plan: 'team', maxThreads: null, polarSubscriptionId: 'sub-2' });
    expect(mails.at(-1)!.subject).toBe('Acme is now on OpenParley Team');
    expect(await (await b.request(`${CONTROL}/workspaces/acme?renewing=1`)).text()).toContain('Acme is active');

    // Late news about the old subscription no longer affects the workspace.
    await webhook(cloud, 'subscription.revoked', subscription(signup, { status: 'canceled', at: T0 + 9000 }));
    expect(cloud.control.find('acme')!.plan).toBe('team');
    // And the link is spent once the workspace is paid for.
    expect((await b.post(`${CONTROL}/renew`, { token, plan: 'team' })).headers.get('location')).toBe('/workspaces/acme');
  });

  test('a paused (not ended) Polar subscription is resumed in the customer portal', async () => {
    const { cloud, b, sessions, checkouts } = await ended('paused');
    const token = new URL(cloud.renewalUrl('acme', 60_000)).searchParams.get('token')!;
    expect(await (await b.request(`${CONTROL}/renew?token=${token}`)).text()).toContain('Open the billing portal');
    const res = await b.post(`${CONTROL}/renew`, { token });
    expect(res.headers.get('location')).toBe('https://sandbox.polar.sh/openparley/portal?session=1');
    expect(sessions).toEqual(['cust-1']);
    expect(checkouts).toHaveLength(1);
  });

  test('upgrade links expire, and sending them is rate limited', async () => {
    const { cloud, b, mails } = await ended();
    const expired = new URL(cloud.renewalUrl('acme', -1)).searchParams.get('token')!;
    expect((await b.request(`${CONTROL}/renew?token=${expired}`)).status).toBe(404);
    expect((await b.post(`${CONTROL}/renew`, { token: 'made-up' })).status).toBe(404);

    const before = mails.length;
    for (let i = 0; i < 3; i++) expect((await b.post(`${CONTROL}/workspaces/acme/renewal-link`, {})).status).toBe(200);
    expect((await b.post(`${CONTROL}/workspaces/acme/renewal-link`, {})).status).toBe(429);
    expect(mails.length - before).toBe(3);
  });

  test('paying twice for one upgrade never moves the workspace off a live subscription', async () => {
    const { cloud } = await ended();
    await webhook(cloud, 'subscription.active', subscription('', { id: 'sub-2', metadata: { renew: 'acme' }, at: T0 + 5000 }));
    await webhook(cloud, 'subscription.active', subscription('', { id: 'sub-3', metadata: { renew: 'acme' }, at: T0 + 6000 }));
    expect(cloud.control.find('acme')!.polarSubscriptionId).toBe('sub-2');
  });
});

describe('paused workspaces (operator only)', () => {
  const navigate = (cloud: Cloud, url: string, headers: Record<string, string> = { 'sec-fetch-mode': 'navigate' }) => cloud.fetch(new Request(url, { headers }));

  test('people go to its page on the control plane; scripts and API calls get 402; no payment is offered', async () => {
    const { cloud, mails } = setup({ env: { SUPPORT_EMAIL: 'help@parley.test' } });
    cloud.provision({ slug: 'acme', name: 'Acme', plan: 'free', billingEmail: 'olivia@acme.test' });
    cloud.control.update('acme', { status: 'suspended' });
    for (const headers of [{ 'sec-fetch-mode': 'navigate' }, { accept: 'text/html,application/xhtml+xml' }] as Record<string, string>[]) {
      const res = await navigate(cloud, `https://acme.${DOMAIN}/admin`, headers);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${CONTROL}/workspaces/acme`);
    }
    expect((await navigate(cloud, `https://acme.${DOMAIN}/openparley.js`, { 'sec-fetch-mode': 'no-cors', accept: '*/*' })).status).toBe(402);
    expect((await navigate(cloud, `https://acme.${DOMAIN}/api/me`, { 'sec-fetch-mode': 'cors', accept: 'text/html' })).status).toBe(402);
    expect((await cloud.fetch(new Request(`https://acme.${DOMAIN}/login`, { method: 'POST', headers: { 'sec-fetch-mode': 'navigate' } }))).status).toBe(402);

    const b = browser(cloud);
    const page = await (await b.request(`${CONTROL}/workspaces/acme`)).text();
    expect(page).toContain('Acme is paused');
    expect(page).toContain('help@parley.test');
    expect(page).not.toContain('renewal-link');
    expect((await b.post(`${CONTROL}/workspaces/acme/renewal-link`, {})).status).toBe(303);
    const token = new URL(cloud.renewalUrl('acme', 60_000)).searchParams.get('token')!;
    expect((await b.request(`${CONTROL}/renew?token=${token}`)).headers.get('location')).toBe('/workspaces/acme');
    expect(mails).toHaveLength(0);
  });
});

describe('free plan', () => {
  const confirmLinkIn = (text: string) => /(https:\/\/cloud\.parley\.test\/signup\/confirm\?signup=[\w-]+)/.exec(text)![1]!;

  async function freeWorkspace(ctx = setup({ env: { SUPPORT_EMAIL: 'help@parley.test' } })) {
    const b = browser(ctx.cloud);
    await b.post(`${CONTROL}/signup`, { name: 'Acme', slug: 'acme', email: 'olivia@acme.test', plan: 'free' });
    const link = confirmLinkIn(ctx.mails.at(-1)!.text);
    await b.post(`${CONTROL}/signup/confirm`, { signup: new URL(link).searchParams.get('signup')! });
    return { ...ctx, b, link };
  }

  test('sign-up confirms the email address, then creates a one-person workspace', async () => {
    const { cloud, mails, checkouts } = setup();
    const b = browser(cloud);
    const res = await b.post(`${CONTROL}/signup`, { name: 'Acme', slug: 'acme', email: 'olivia@acme.test', plan: 'free' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Check your email');
    expect(checkouts).toHaveLength(0);
    expect(cloud.control.find('acme')).toBeNull();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('olivia@acme.test');
    const link = confirmLinkIn(mails[0]!.text);

    // The address is held for the person who signed up.
    expect((await browser(cloud).post(`${CONTROL}/signup`, { name: 'X', slug: 'acme', email: 'x@x.test', plan: 'free' })).status).toBe(400);

    // Opening the link (or a mail scanner prefetching it) creates nothing; the button does.
    const page = await (await b.request(link)).text();
    expect(page).toContain('Create workspace');
    expect(cloud.control.find('acme')).toBeNull();

    const signup = new URL(link).searchParams.get('signup')!;
    const created = await browser(cloud).post(`${CONTROL}/signup/confirm`, { signup });
    expect(created.status).toBe(303);
    const tenant = cloud.control.find('acme')!;
    expect(tenant).toMatchObject({ plan: 'free', maxMembers: 1, maxThreads: null, maxProjects: null, billingEmail: 'olivia@acme.test', polarSubscriptionId: null });
    expect(created.headers.get('location')).toBe(cloud.setupUrl(tenant));

    // Confirming again doesn't create a second workspace; it points to the same setup link until the owner exists.
    await browser(cloud).post(`${CONTROL}/signup/confirm`, { signup });
    expect(cloud.stats().workspaces).toBe(1);
    expect(await (await b.request(link)).text()).toContain(tenant.setupToken);
    await b.post(`https://acme.${DOMAIN}/setup`, { token: tenant.setupToken, name: 'Olivia', email: 'olivia@acme.test', password: 'correct horse battery' });
    const after = await (await b.request(link)).text();
    expect(after).toContain('Sign in at');
    expect(after).not.toContain(tenant.setupToken);
  });

  test('confirming creates the Polar customer; an existing customer with that email is reused; Polar being down doesn\'t block sign-up', async () => {
    const ctx = setup();
    const confirm = async (cloud: Cloud, slug: string, email: string) => {
      const b = browser(cloud);
      await b.post(`${CONTROL}/signup`, { name: slug, slug, email, plan: 'free' });
      const res = await b.post(`${CONTROL}/signup/confirm`, { signup: cloud.control.pendingFreeSignup(slug)!.id });
      expect(res.status).toBe(303);
      return cloud.control.find(slug)!;
    };
    expect(await confirm(ctx.cloud, 'acme', 'olivia@acme.test')).toMatchObject({ polarCustomerId: 'cust-1', polarSubscriptionId: null });
    expect(ctx.customers.get('olivia@acme.test')).toMatchObject({ name: 'acme', metadata: { workspace: 'acme' } });
    // Same person, second workspace: Polar has one customer per email.
    expect((await confirm(ctx.cloud, 'acme-labs', 'olivia@acme.test')).polarCustomerId).toBe('cust-1');
    expect(ctx.customers.size).toBe(1);

    // Free sign-up only needs the confirmation email; a Polar outage just leaves the customer link empty.
    const down = setup({ polarDown: true });
    const b = browser(down.cloud);
    down.cloud.control.createSignup({ slug: 'calm', name: 'Calm', email: 'c@calm.test', plan: 'free', browserHash: 'x', expiresAt: Date.now() + 60_000 });
    expect((await b.post(`${CONTROL}/signup/confirm`, { signup: down.cloud.control.pendingFreeSignup('calm')!.id })).status).toBe(303);
    expect(down.cloud.control.find('calm')).toMatchObject({ plan: 'free', polarCustomerId: null });
  });

  test('confirmation links expire, and only free sign-ups can be confirmed', async () => {
    const { cloud, checkouts } = setup();
    const b = browser(cloud);
    await b.post(`${CONTROL}/signup`, { name: 'Acme', slug: 'acme', email: 'olivia@acme.test', plan: 'free' });
    const signup = cloud.control.pendingFreeSignup('acme')!;
    cloud.control.setSignupExpiry(signup.id, Date.now() - 1);
    expect((await b.request(cloud.confirmUrl(signup.id))).status).toBe(404);
    expect((await b.post(`${CONTROL}/signup/confirm`, { signup: signup.id })).status).toBe(404);
    expect(cloud.control.pendingFreeSignup('acme')).toBeNull();

    await signUp(b, { slug: 'paid' });
    expect((await b.post(`${CONTROL}/signup/confirm`, { signup: signupIdOf(checkouts[0]!) })).status).toBe(404);
    expect(cloud.stats().workspaces).toBe(0);
  });

  test('if the confirmation email can\'t be sent, the address is released', async () => {
    const { cloud } = setup({ mailDown: true });
    const res = await browser(cloud).post(`${CONTROL}/signup`, { name: 'Acme', slug: 'acme', email: 'o@acme.test', plan: 'free' });
    expect(res.status).toBe(502);
    expect(cloud.control.slugAvailable('acme', null)).toBe(true);
  });

  test('the workspace page offers Team with a trial; the billing contact upgrades and the member limit is lifted', async () => {
    const { cloud, b, mails, checkouts } = await freeWorkspace();
    const page = await (await b.request(`${CONTROL}/workspaces/acme`)).text();
    expect(page).toContain('Acme is on the free plan');
    expect(page).toContain('Free is for one person');
    expect(page).toContain('free for 31 days, then $19/month');
    expect(page).toContain('Email an upgrade link to o•••@acme.test');

    await b.post(`${CONTROL}/workspaces/acme/renewal-link`, {});
    const mail = mails.at(-1)!;
    expect(mail).toMatchObject({ to: 'olivia@acme.test', subject: 'Upgrade your OpenParley workspace Acme' });
    const link = /(https:\/\/cloud\.parley\.test\/renew\?token=[\w-]+)/.exec(mail.text)![1]!;
    expect(await (await b.request(link)).text()).toContain('Upgrade Acme');

    const token = new URL(link).searchParams.get('token')!;
    expect((await b.post(`${CONTROL}/renew`, { token })).status).toBe(303);
    // A first upgrade keeps the product's trial (no allow_trial override), as the customer made at sign-up.
    expect(checkouts[0]!.body).toEqual({
      products: [PRODUCTS.team],
      customer_id: 'cust-1',
      success_url: `${CONTROL}/workspaces/acme?renewing=1`,
      return_url: `${CONTROL}/workspaces/acme`,
      metadata: { renew: 'acme' },
    });
    expect(await (await b.request(`${CONTROL}/workspaces/acme?renewing=1`)).text()).toContain('Upgrading Acme');

    // Polar reports a subscription in its trial as `trialing`: that's paid as far as the workspace goes.
    await webhook(cloud, 'subscription.created', subscription('', { status: 'trialing', metadata: { renew: 'acme' }, customer: { email: 'billing@acme.test' } }));
    expect(cloud.control.find('acme')).toMatchObject({ status: 'active', plan: 'team', maxMembers: null, polarSubscriptionId: 'sub-1', billingEmail: 'billing@acme.test' });
    expect(mails.at(-1)!.subject).toBe('Acme is now on OpenParley Team');
    expect(await (await b.request(`${CONTROL}/workspaces/acme?renewing=1`)).text()).toContain('Acme is active');
    // The link is spent: a paid workspace has nothing to upgrade.
    expect((await b.post(`${CONTROL}/renew`, { token })).headers.get('location')).toBe('/workspaces/acme');
  });

  test('the workspace\'s own admin page links to its plan page', async () => {
    const { cloud, b } = await freeWorkspace();
    const tenant = cloud.control.find('acme')!;
    const owner = await b.post(`https://acme.${DOMAIN}/setup`, { token: tenant.setupToken, name: 'Olivia', email: 'olivia@acme.test', password: 'correct horse battery' });
    const cookie = owner.headers.get('set-cookie')!.split(';')[0]!;
    const admin = await (await cloud.fetch(new Request(`https://acme.${DOMAIN}/admin`, { headers: { cookie } }))).text();
    expect(admin).toContain('1 of 1 seats used');
    expect(admin).toContain('Add more seats');
    expect(admin).toContain(`href="${CONTROL}/workspaces/acme"`);
  });
});

describe('control.db', () => {
  test('a database from before migrations is upgraded in place', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'openparley-control-'));
    const old = new Database(join(dataDir, 'control.db'), { create: true });
    old.exec(`CREATE TABLE IF NOT EXISTS tenants (
        slug TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
        setup_token TEXT NOT NULL, max_members INTEGER, max_projects INTEGER, created_at INTEGER NOT NULL);
      INSERT INTO tenants VALUES ('acme', 'Acme', 'active', 'tok', 5, NULL, 1);`);
    old.close();
    const control = new ControlStore(dataDir);
    expect(control.find('acme')).toMatchObject({ slug: 'acme', maxMembers: 5, plan: null, billingEmail: null, suspendedAt: null });
    control.update('acme', { status: 'suspended' });
    expect(control.find('acme')!.suspendedAt).toBeNumber();
    control.close();
  });
});

describe('client IP', () => {
  test('workspaces see the real client IP, so one visitor can’t lock out everyone', async () => {
    const { cloud } = setup();
    cloud.provision({ slug: 'acme', name: 'Acme' });
    const from = (address: string) => ({ requestIP: () => ({ address, family: 'IPv4', port: 1 }) });
    const redeem = (address: string) =>
      cloud.fetch(
        new Request(`https://acme.${DOMAIN}/invite/bogus`, {
          method: 'POST',
          headers: { origin: `https://acme.${DOMAIN}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: 'name=x',
        }),
        from(address),
      );
    for (let i = 0; i < 10; i++) expect((await redeem('203.0.113.1')).status).toBe(404);
    expect((await redeem('203.0.113.1')).status).toBe(429);
    expect((await redeem('198.51.100.7')).status).toBe(404);
  });
});
