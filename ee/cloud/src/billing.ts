import type { Cloud } from './cloud';
import type { CloudConfig } from './config';
import { slugProblem, type Signup, type Tenant } from './control';
import type { Mailer } from './mailer';
import { isPaidPlanId, isPlanId, planLimits, PLANS, type Plan } from './plans';
import type { PolarEvent, PolarSubscription } from './polar';

export type EventOutcome = 'processed' | 'duplicate';

/** Upgrade link in the "subscription ended" email; a fresh one can be requested from the workspace's page. */
export const ENDED_EMAIL_LINK_MS = 30 * 24 * 60 * 60 * 1000;
export const REQUESTED_RENEWAL_MS = 24 * 60 * 60 * 1000;

/**
 * Turns Polar subscription events into workspace plans. Every `subscription.*` event carries the
 * whole subscription, so the event type barely matters: the subscription's status decides. That
 * keeps the handling correct when Polar delivers events late, twice, or out of order.
 *
 * Billing never pauses a workspace: when a subscription ends, the workspace drops to the Free plan
 * and keeps everything; only starting threads beyond the free limit stops. Pausing (`suspended`)
 * is an operator's decision, and paying doesn't undo it.
 */
export class Billing {
  constructor(
    private readonly cloud: Cloud,
    private readonly config: CloudConfig,
    private readonly mailer: Mailer,
  ) {}

  /** Applies a verified event. Throws (so Polar retries) only if nothing was committed. */
  async handle(deliveryId: string, event: PolarEvent, raw: string): Promise<EventOutcome> {
    const { control } = this.cloud;
    let followUp: (() => Promise<void>) | null = null;
    const fresh = control.transaction(() => {
      if (!control.recordEvent(deliveryId, event.type, raw)) return false;
      if (event.type.startsWith('subscription.') && isSubscription(event.data)) followUp = this.apply(event.data);
      return true;
    });
    if (!fresh) return 'duplicate';
    // Outside the transaction: the event is already recorded, so a failing email must not make Polar retry.
    try {
      await (followUp as (() => Promise<void>) | null)?.();
    } catch (error) {
      console.error(`Billing follow-up for ${event.type} failed:`, error);
    }
    return 'processed';
  }

  planForProduct(productId: string): Plan | null {
    const entry = Object.entries(this.config.polar?.products ?? {}).find(([, id]) => id === productId);
    return entry && isPlanId(entry[0]) ? PLANS[entry[0]] : null;
  }

  private apply(sub: PolarSubscription): (() => Promise<void>) | null {
    const { control } = this.cloud;
    const modifiedAt = Date.parse(sub.modified_at ?? sub.created_at);
    if (!control.recordSubscription({ id: sub.id, status: sub.status, productId: sub.product_id, modifiedAt })) return null;

    const standing = subscriptionStanding(sub.status);
    const tenant = control.findBySubscription(sub.id);
    if (!tenant) {
      if (standing !== 'paid') return null;
      return typeof sub.metadata.renew === 'string' ? this.renew(sub, sub.metadata.renew) : this.provision(sub);
    }
    if (!standing) return null;

    if (standing === 'ended') {
      if (tenant.plan === 'free') return null;
      control.update(tenant.slug, { plan: 'free', ...planLimits(PLANS.free) });
      return () => this.mailEnded(tenant);
    }
    // Paid: a plan change, or a subscription that came back (e.g. resumed in Polar's portal).
    const resumed = tenant.plan === 'free';
    const plan = this.planForProduct(sub.product_id) ?? (resumed ? PLANS.team : null);
    if (!plan) console.warn(`Subscription ${sub.id} has unknown product ${sub.product_id}; keeping ${tenant.slug}'s limits.`);
    control.update(tenant.slug, { polarCustomerId: sub.customer_id, ...(plan && { plan: plan.id, ...planLimits(plan) }) });
    return resumed ? () => this.mailUpgraded(control.find(tenant.slug)!) : null;
  }

  private provision(sub: PolarSubscription): (() => Promise<void>) | null {
    const { control } = this.cloud;
    const signupId = sub.metadata.signup;
    const signup = typeof signupId === 'string' ? control.findSignup(signupId) : null;
    if (!signup) {
      console.error(`Subscription ${sub.id} is active but has no matching sign-up (metadata.signup = ${String(signupId)}). Provision it by hand.`);
      return null;
    }
    if (signup.tenantSlug) return null;
    const plan = this.planForProduct(sub.product_id) ?? (isPaidPlanId(signup.plan) ? PLANS[signup.plan] : PLANS.team);
    const tenant = control.create({
      // The reservation can lapse while someone sits on the checkout page; they paid, so they still get a workspace.
      slug: freeSlug(signup.slug, (slug) => !control.find(slug)),
      name: signup.name,
      plan: plan.id,
      ...planLimits(plan),
      billingEmail: sub.customer?.email ?? signup.email,
      polarCustomerId: sub.customer_id,
      polarSubscriptionId: sub.id,
    });
    control.completeSignup(signup.id, tenant.slug);
    return async () => {
      this.cloud.open(tenant.slug);
      await this.mailReady(tenant);
    };
  }

  /** A new subscription for a free workspace: it takes over from the one that ended, if any. */
  private renew(sub: PolarSubscription, slug: string): (() => Promise<void>) | null {
    const { control } = this.cloud;
    const tenant = control.find(slug);
    if (!tenant) {
      console.error(`Subscription ${sub.id} renews "${slug}", which doesn't exist. Refund it or provision by hand.`);
      return null;
    }
    const current = tenant.polarSubscriptionId ? control.findSubscription(tenant.polarSubscriptionId) : null;
    if (current && subscriptionStanding(current.status as PolarSubscription['status']) === 'paid') {
      // E.g. two checkouts paid from two tabs. Never silently bill twice for one workspace.
      console.error(`Subscription ${sub.id} renews "${slug}", which is already paid by ${current.id}. Refund one of them.`);
      return null;
    }
    // Someone paid; never leave them on the free plan's limits because a product id was unexpected.
    const plan = this.planForProduct(sub.product_id) ?? PLANS.team;
    control.update(slug, {
      polarSubscriptionId: sub.id,
      polarCustomerId: sub.customer_id,
      billingEmail: sub.customer?.email ?? tenant.billingEmail,
      plan: plan.id,
      ...planLimits(plan),
    });
    const upgraded = control.find(slug)!;
    return () => this.mailUpgraded(upgraded);
  }

  private async mailUpgraded(tenant: Tenant) {
    if (!tenant.billingEmail) return;
    const planName = PLANS[isPlanId(tenant.plan) ? tenant.plan : 'team'].name;
    await this.mailer.send({
      to: tenant.billingEmail,
      replyTo: this.config.supportEmail ?? undefined,
      subject: `${tenant.name} is now on OpenParley ${planName}`,
      text: `"${tenant.name}" (${this.cloud.workspaceUrl(tenant.slug)}) is now on the ${planName} plan: invite your whole team from its admin page. Thanks!`,
    });
  }

  /** The link that proves a free sign-up's email address; opening it lets them create the workspace. */
  async sendSignupConfirmation(signup: Signup): Promise<void> {
    await this.mailer.send({
      to: signup.email,
      replyTo: this.config.supportEmail ?? undefined,
      subject: `Confirm your OpenParley workspace ${signup.name}`,
      text: [
        `To create your free OpenParley workspace "${signup.name}" at ${this.cloud.workspaceUrl(signup.slug)}, open:`,
        this.cloud.confirmUrl(signup.id),
        '',
        `The link works for 24 hours. Free is for one person and their coding agents; when you want your team in, upgrade to ${PLANS.team.name}.`,
        "If you didn't sign up, ignore this email.",
      ].join('\n'),
    });
  }

  /** Emails a link that lets the billing contact upgrade a free workspace. */
  async sendRenewalLink(tenant: Tenant): Promise<void> {
    if (!tenant.billingEmail) throw new Error(`${tenant.slug} has no billing contact.`);
    const link = this.cloud.renewalUrl(tenant.slug, REQUESTED_RENEWAL_MS);
    await this.mailer.send({
      to: tenant.billingEmail,
      subject: `Upgrade your OpenParley workspace ${tenant.name}`,
      text: [
        `Someone asked to upgrade "${tenant.name}" to a paid plan. To pay, open:`,
        link,
        '',
        "The link works for 24 hours. If you didn't ask for this, ignore this email.",
      ].join('\n'),
      replyTo: this.config.supportEmail ?? undefined,
    });
  }

  private async mailReady(tenant: Tenant) {
    const portal = this.config.polar?.portalUrl;
    await this.mailer.send({
      to: tenant.billingEmail!,
      replyTo: this.config.supportEmail ?? undefined,
      subject: `Your OpenParley workspace ${tenant.name} is ready`,
      text: [
        `Your OpenParley workspace "${tenant.name}" is ready at ${this.cloud.workspaceUrl(tenant.slug)}`,
        '',
        'Create the owner account with this one-time link:',
        this.cloud.setupUrl(tenant),
        '',
        ...(portal ? [`Invoices, payment method and cancellation: ${portal}`] : []),
      ].join('\n'),
    });
  }

  private async mailEnded(tenant: Tenant) {
    if (!tenant.billingEmail) return;
    const members = this.cloud.membersUsed(tenant.slug);
    const free = PLANS.free.maxMembers!;
    await this.mailer.send({
      to: tenant.billingEmail,
      replyTo: this.config.supportEmail ?? undefined,
      subject: `Your OpenParley workspace ${tenant.name} is now on the free plan`,
      text: [
        `The subscription for "${tenant.name}" (${this.cloud.workspaceUrl(tenant.slug)}) has ended, so the workspace is on the Free plan now.`,
        'Nothing is deleted: all threads, projects and members stay, and everyone can keep replying and resolving.',
        members > free
          ? `Free is for one person and this workspace has ${members} members, so nobody can start new threads until it upgrades or members are removed.`
          : 'Free is for one person; inviting someone needs Team again.',
        '',
        'To upgrade again, open:',
        this.cloud.renewalUrl(tenant.slug, ENDED_EMAIL_LINK_MS),
        '',
        `That link works for 30 days. After that, visit ${this.cloud.controlUrl()}/workspaces/${tenant.slug} to get a new one.`,
      ].join('\n'),
    });
  }
}

/** Null: no change (a checkout that hasn't completed yet). */
function subscriptionStanding(status: PolarSubscription['status']): 'paid' | 'ended' | null {
  switch (status) {
    case 'active':
    case 'trialing':
    // Polar retries failed renewals for up to 21 days and then revokes; that is the grace period.
    case 'past_due':
      return 'paid';
    case 'canceled':
    case 'unpaid':
    case 'paused':
    case 'incomplete_expired':
      return 'ended';
    default:
      return null;
  }
}

function isSubscription(data: unknown): data is PolarSubscription {
  const sub = data as Partial<PolarSubscription>;
  return (
    typeof sub.id === 'string' &&
    typeof sub.status === 'string' &&
    typeof sub.product_id === 'string' &&
    typeof sub.customer_id === 'string' &&
    typeof sub.created_at === 'string' &&
    typeof sub.metadata === 'object' &&
    sub.metadata !== null
  );
}

export function freeSlug(wanted: string, free: (slug: string) => boolean): string {
  if (free(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted.slice(0, 32 - `-${n}`.length).replace(/-+$/, '')}-${n}`;
    if (!slugProblem(candidate) && free(candidate)) return candidate;
  }
}
