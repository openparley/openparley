import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PolarConfig } from './config';

/** The fields of Polar's Subscription object that the control plane reads. */
export interface PolarSubscription {
  id: string;
  status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
  created_at: string;
  modified_at: string | null;
  customer_id: string;
  product_id: string;
  metadata: Record<string, string | number | boolean>;
  customer: { email: string };
}

export interface PolarEvent {
  type: string;
  timestamp: string;
  data: unknown;
}

export class WebhookVerificationError extends Error {}

const TOLERANCE_S = 5 * 60;

/**
 * Verifies a Polar webhook (Standard Webhooks: HMAC-SHA256 over `id.timestamp.body`). Secrets
 * created before 8 Sep 2026 are keyed with the UTF-8 bytes of the whole `whsec_…` string, newer
 * ones with its base64-decoded tail; like Polar's SDK, both keys are tried.
 */
export function verifyWebhook(body: string, headers: Headers, secret: string, now = Date.now()): PolarEvent {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError('Missing webhook headers.');
  const sentAt = Number(timestamp);
  if (!Number.isInteger(sentAt) || Math.abs(now / 1000 - sentAt) > TOLERANCE_S) throw new WebhookVerificationError('Webhook timestamp out of range.');

  const signed = `${id}.${timestamp}.${body}`;
  const expected = webhookKeys(secret).map((key) => createHmac('sha256', key).update(signed).digest());
  const valid = signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return expected.some((digest) => digest.length === given.length && timingSafeEqual(digest, given));
  });
  if (!valid) throw new WebhookVerificationError('Invalid webhook signature.');

  const event = JSON.parse(body) as PolarEvent;
  if (typeof event?.type !== 'string' || typeof event.data !== 'object' || event.data === null) {
    throw new WebhookVerificationError('Malformed webhook payload.');
  }
  return event;
}

function webhookKeys(secret: string): Buffer[] {
  const keys = [Buffer.from(secret, 'utf8')];
  const tail = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(tail)) keys.unshift(Buffer.from(tail, 'base64'));
  return keys;
}

/** Signs a payload the way Polar does (Standard Webhooks). For tests and the fake Polar server. */
export function signWebhook(secret: string, id: string, timestampS: number, body: string): string {
  const key = webhookKeys(secret)[0]!;
  return `v1,${createHmac('sha256', key).update(`${id}.${timestampS}.${body}`).digest('base64')}`;
}

export interface Checkout {
  id: string;
  url: string;
  expiresAt: number;
}

export class PolarClient {
  constructor(
    private readonly config: PolarConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** With `customerId`, the order joins that existing Polar customer (same portal, same invoices). */
  async createCheckout(input: {
    productId: string;
    email: string;
    customerId?: string | null;
    successUrl: string;
    returnUrl: string;
    metadata: Record<string, string>;
    /** False switches off the product's trial for this checkout (a workspace that was paid before). */
    allowTrial?: boolean;
  }): Promise<Checkout> {
    const res = await this.post('/v1/checkouts/', {
      products: [input.productId],
      ...(input.customerId ? { customer_id: input.customerId } : { customer_email: input.email }),
      success_url: input.successUrl,
      return_url: input.returnUrl,
      // Polar copies checkout metadata onto the subscription, which is how the webhook finds the sign-up.
      metadata: input.metadata,
      ...(input.allowTrial === false && { allow_trial: false }),
    });
    const checkout = (await res.json()) as { id: string; url: string; expires_at: string };
    return { id: checkout.id, url: checkout.url, expiresAt: Date.parse(checkout.expires_at) };
  }

  /**
   * The Polar customer for this email, created if needed, so free workspaces show up in Polar and
   * a later upgrade checks out as that customer. Polar keeps one customer per email, so a person
   * with two workspaces gets the existing one back. Bounded by a timeout: callers treat it as best effort.
   */
  async ensureCustomer(input: { email: string; name: string; metadata: Record<string, string> }): Promise<string> {
    const signal = AbortSignal.timeout(5000);
    const created = await this.send('POST', '/v1/customers/', { email: input.email, name: input.name, metadata: input.metadata }, signal);
    if (created.ok) return ((await created.json()) as { id: string }).id;
    const found = await this.send('GET', `/v1/customers/?${new URLSearchParams({ email: input.email, limit: '1' })}`, undefined, signal);
    const id = found.ok ? ((await found.json()) as { items?: Array<{ id: string }> }).items?.[0]?.id : undefined;
    if (!id) throw new Error(`Polar /v1/customers/ failed: ${created.status} ${(await created.text()).slice(0, 500)}`);
    return id;
  }

  /** A short-lived, already signed-in link to the customer portal. Create it at the moment of the click. */
  async portalUrl(customerId: string, returnUrl: string): Promise<string> {
    const res = await this.post('/v1/customer-sessions/', { customer_id: customerId, return_url: returnUrl });
    return ((await res.json()) as { customer_portal_url: string }).customer_portal_url;
  }

  private send(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    return this.fetchFn(`${this.config.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        accept: 'application/json',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const res = await this.send('POST', path, body);
    if (!res.ok) throw new Error(`Polar ${path} failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
    return res;
  }
}
