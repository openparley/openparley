// A stand-in for Polar in development and e2e: hosted checkout, signed webhooks, and test hooks to
// change a subscription. Implements only what the control plane uses. Never point production at it.
//   bun ee/cloud/dev/fake-polar.ts   (PORT, WEBHOOK_URL and WEBHOOK_SECRET from the environment)
import { randomUUID } from 'node:crypto';
import { signWebhook, type PolarSubscription } from '../src/polar';

interface FakeCheckout {
  id: string;
  productId: string;
  email: string;
  successUrl: string;
  metadata: Record<string, string>;
  subscriptionId: string | null;
}

export interface FakePolarOptions {
  port: number;
  webhookUrl: string;
  webhookSecret: string;
  /** Delay before webhooks of a completed checkout go out, like Polar's asynchronous delivery. */
  deliveryDelayMs?: number;
}

export function startFakePolar({ port, webhookUrl, webhookSecret, deliveryDelayMs = 500 }: FakePolarOptions) {
  const checkouts = new Map<string, FakeCheckout>();
  const subscriptions = new Map<string, PolarSubscription>();
  /** Like Polar: one customer per email. */
  const customers = new Map<string, { id: string; email: string; name: string }>();
  const customerFor = (email: string) => `cust-${email}`;
  let clock = Date.now();
  // Strictly increasing, so each change is newer than the last even within one millisecond.
  const tick = () => new Date((clock = Math.max(clock + 1, Date.now()))).toISOString();

  const deliver = async (type: string, data: PolarSubscription) => {
    const id = `msg_${randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signWebhook(webhookSecret, id, timestamp, body) },
      body,
    });
    if (!res.ok) console.error(`[fake-polar] ${type} → ${res.status} ${await res.text()}`);
  };

  const server: Bun.Server<undefined> = Bun.serve({
    port,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const self: string = `http://localhost:${server.port}`;

      if (request.method === 'POST' && url.pathname === '/v1/checkouts/') {
        if (!request.headers.get('authorization')?.startsWith('Bearer ')) return new Response('unauthorized', { status: 401 });
        const body = (await request.json()) as { products: string[]; customer_email?: string; customer_id?: string; success_url: string; metadata: Record<string, string> };
        const email = body.customer_id ? [...customers.values()].find((c) => c.id === body.customer_id)?.email : body.customer_email;
        if (!email) return Response.json({ detail: 'Unknown customer' }, { status: 422 });
        const checkout: FakeCheckout = { id: randomUUID(), productId: body.products[0]!, email, successUrl: body.success_url, metadata: body.metadata, subscriptionId: null };
        checkouts.set(checkout.id, checkout);
        return Response.json({ id: checkout.id, url: `${self}/checkout/${checkout.id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
      }

      const checkoutMatch = /^\/checkout\/([\w-]+)$/.exec(url.pathname);
      const checkout = checkoutMatch ? checkouts.get(checkoutMatch[1]!) : undefined;
      if (checkout && request.method === 'GET') {
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Fake Polar checkout</title><body style="font:16px system-ui;max-width:480px;margin:10vh auto">
<h1>Fake Polar checkout</h1><p>Product <code>${checkout.productId}</code> for ${escape(checkout.email)}.</p>
<form method="post"><button type="submit">Pay</button></form></body>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      if (checkout && request.method === 'POST') {
        if (!checkout.subscriptionId) {
          const created = tick();
          const sub: PolarSubscription = {
            id: randomUUID(),
            status: 'incomplete',
            created_at: created,
            modified_at: created,
            customer_id: customerFor(checkout.email),
            product_id: checkout.productId,
            metadata: checkout.metadata,
            customer: { email: checkout.email },
          };
          checkout.subscriptionId = sub.id;
          if (!customers.has(checkout.email)) customers.set(checkout.email, { id: customerFor(checkout.email), email: checkout.email, name: '' });
          subscriptions.set(sub.id, sub);
          setTimeout(async () => {
            await deliver('subscription.created', { ...sub });
            Object.assign(sub, { status: 'active', modified_at: tick() });
            await deliver('subscription.active', { ...sub });
          }, deliveryDelayMs);
        }
        return Response.redirect(checkout.successUrl.replace('{CHECKOUT_ID}', checkout.id), 303);
      }

      // Test hooks.
      if (request.method === 'GET' && url.pathname === '/test/subscriptions') {
        const email = url.searchParams.get('email');
        return Response.json([...subscriptions.values()].filter((s) => !email || s.customer.email === email));
      }
      const subMatch = /^\/test\/subscriptions\/([\w-]+)$/.exec(url.pathname);
      const sub = subMatch ? subscriptions.get(subMatch[1]!) : undefined;
      if (sub && request.method === 'POST') {
        const change = (await request.json()) as { status?: PolarSubscription['status']; product_id?: string };
        Object.assign(sub, change, { modified_at: tick() });
        await deliver(sub.status === 'canceled' ? 'subscription.revoked' : 'subscription.updated', { ...sub });
        return Response.json(sub);
      }
      if (url.pathname === '/v1/customers/') {
        if (!request.headers.get('authorization')?.startsWith('Bearer ')) return new Response('unauthorized', { status: 401 });
        if (request.method === 'GET') {
          const email = url.searchParams.get('email');
          return Response.json({ items: [...customers.values()].filter((c) => !email || c.email === email) });
        }
        const body = (await request.json()) as { email: string; name: string };
        if (customers.has(body.email)) return Response.json({ detail: 'A customer with this email address already exists.' }, { status: 422 });
        const customer = { id: customerFor(body.email), email: body.email, name: body.name };
        customers.set(body.email, customer);
        return Response.json(customer, { status: 201 });
      }
      if (request.method === 'POST' && url.pathname === '/v1/customer-sessions/') {
        const body = (await request.json()) as { customer_id: string };
        return Response.json({ customer_portal_url: `${self}/portal?customer=${encodeURIComponent(body.customer_id)}` }, { status: 201 });
      }
      if (url.pathname === '/portal') return new Response('Fake Polar customer portal', { headers: { 'content-type': 'text/plain' } });
      return new Response('not found', { status: 404 });
    },
  });
  return server;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

if (import.meta.main) {
  const env = process.env;
  if (!env.WEBHOOK_URL || !env.WEBHOOK_SECRET) throw new Error('Set WEBHOOK_URL and WEBHOOK_SECRET.');
  const server = startFakePolar({ port: Number(env.PORT ?? 4176), webhookUrl: env.WEBHOOK_URL, webhookSecret: env.WEBHOOK_SECRET });
  console.log(`Fake Polar listening on ${server.url}`);
}
