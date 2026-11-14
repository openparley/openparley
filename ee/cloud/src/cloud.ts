import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { openInstance, signAssertion, type Instance } from '@openparley/sync';
import { AccountStore, type Account } from './accounts';
import { Billing } from './billing';
import { controlPlane } from './control-plane';
import { ControlStore, type NewTenant, type Tenant } from './control';
import { urlFor, type CloudConfig } from './config';
import { logMailer, resendMailer, type Mailer } from './mailer';
import { PolarClient } from './polar';

interface Open {
  instance: Instance;
  /** Limits the instance was opened with; a change in control.db reopens it. */
  limitsKey: string;
  lastUsed: number;
}

export interface CloudStats {
  workspaces: number;
  open: number;
}

export interface CloudDeps {
  mailer?: Mailer;
  /** Used for calls to Polar; tests replace it. */
  fetch?: typeof fetch;
}

/** Bun's server, passed along so Sync can read the client IP for rate limiting. */
type Server = { requestIP(request: Request): { address: string; family: string; port: number } | null };

/**
 * OpenParley Cloud: one process serving many workspaces. Each workspace is an unmodified
 * OpenParley Sync instance with its own SQLite file, picked by hostname. Nothing here touches
 * threads, users or projects; that all stays inside Sync.
 */
export class Cloud {
  readonly control: ControlStore;
  readonly accounts: AccountStore;
  readonly billing: Billing;
  private readonly live = new Map<string, Open>();
  /** Shared with every workspace, so their invite emails go out the same way as Cloud's own. */
  private readonly mailer: Mailer;
  private readonly sweeper: ReturnType<typeof setInterval>;
  private readonly controlApp: ReturnType<typeof controlPlane>;

  constructor(
    private readonly config: CloudConfig,
    deps: CloudDeps = {},
  ) {
    this.control = new ControlStore(config.dataDir);
    this.accounts = new AccountStore(this.control.db);
    this.mailer = deps.mailer ?? (config.mail ? resendMailer(config.mail) : logMailer);
    this.billing = new Billing(this, config, this.mailer);
    const polar = config.polar ? new PolarClient(config.polar, deps.fetch) : null;
    this.controlApp = controlPlane({ cloud: this, config, polar });
    this.sweeper = setInterval(() => this.closeIdle(), Math.min(60_000, config.idleMs));
  }

  fetch = (request: Request, server?: Server): Response | Promise<Response> => {
    const host = hostOf(request);
    if (host === `cloud.${this.config.domain}` || host === this.config.domain) return this.controlApp.fetch(request, server);
    const suffix = `.${this.config.domain}`;
    const slug = host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
    // Every request re-reads the tenant row (an indexed lookup), so suspending or changing
    // limits from the CLI or a billing webhook takes effect immediately.
    const tenant = slug ? this.control.find(slug) : null;
    if (!tenant) return page(404, 'No workspace here', `There is no OpenParley workspace at ${host}.`);
    if (tenant.status === 'suspended') {
      this.evict(tenant.id);
      // Only an operator pauses a workspace (billing drops it to Free instead). People get the control
      // plane's page; the overlay's script and API calls on customers' sites get a plain 402.
      if (isNavigation(request)) return Response.redirect(`${this.controlUrl()}/workspaces/${tenant.slug}`, 302);
      return page(402, 'Workspace paused', `The ${tenant.name} workspace is paused. Its data is kept.`);
    }
    return this.instanceFor(tenant).app.fetch(request, server);
  };

  /** Creates the workspace and its database. Returns the owner's one-time setup link. */
  provision(input: NewTenant): { tenant: Tenant; setupUrl: string } {
    const tenant = this.control.create(input);
    this.instanceFor(tenant);
    return { tenant, setupUrl: this.setupUrl(tenant) };
  }

  /** Opens a workspace's database (creating it on first use). */
  open(slug: string): void {
    const tenant = this.control.find(slug);
    if (tenant) this.instanceFor(tenant);
  }

  /** Whether the workspace's owner account exists yet (after which the setup link is useless). */
  hasOwner(slug: string): boolean {
    const tenant = this.control.find(slug);
    return !!tenant && this.instanceFor(tenant).repo.hasUsers();
  }

  /** Active members of the workspace: what a member limit counts. */
  membersUsed(slug: string): number {
    const tenant = this.control.find(slug);
    return tenant ? this.instanceFor(tenant).repo.listActiveUsers().length : 0;
  }

  /** Threads ever created in the workspace: what a thread limit counts. */
  threadsUsed(slug: string): number {
    const tenant = this.control.find(slug);
    return tenant ? this.instanceFor(tenant).repo.threadsCreated() : 0;
  }

  workspaceUrl(slug: string): string {
    return urlFor(this.config, `${slug}.${this.config.domain}`);
  }

  controlUrl(): string {
    return urlFor(this.config, `cloud.${this.config.domain}`);
  }

  /** Sends an email the way workspaces send theirs (Resend, or the log in development). */
  mail(mail: Parameters<Mailer['send']>[0]): Promise<void> {
    return this.mailer.send(mail);
  }

  /** A link for the billing contact to upgrade a free workspace. Send it only to the billing email. */
  renewalUrl(slug: string, ttlMs: number): string {
    return `${this.controlUrl()}/renew?token=${this.control.createRenewal(slug, ttlMs)}`;
  }

  /** The link in a free sign-up's confirmation email. Send it only to the address that signed up. */
  confirmUrl(signupId: string): string {
    return `${this.controlUrl()}/signup/confirm?signup=${signupId}`;
  }

  setupUrl(tenant: Tenant): string {
    return `${this.workspaceUrl(tenant.slug)}/setup?token=${tenant.setupToken}`;
  }

  /**
   * A link that signs `account` in to the workspace at `next`: a single-use assertion valid for a minute,
   * signed with a key only this workspace accepts. The workspace decides which of its users that is.
   */
  handoffUrl(tenant: Tenant, account: Account, next = '/admin'): string {
    const token = signAssertion(this.handoffKey(tenant), this.workspaceUrl(tenant.slug), {
      githubId: account.githubId ?? undefined,
      githubLogin: account.githubLogin ?? undefined,
      email: account.email,
      emailVerified: true,
      name: account.name ?? undefined,
    });
    return `${this.workspaceUrl(tenant.slug)}/auth/handoff?${new URLSearchParams({ token, next })}`;
  }

  private handoffKey(tenant: Tenant): string {
    return createHmac('sha256', this.control.secret('handoff')).update(`handoff:${tenant.id}`).digest('base64url');
  }

  /** Makes `account` the owner of a workspace that has none yet (signed up while signed in). False if it has one. */
  createOwner(tenant: Tenant, account: Account): boolean {
    const { repo } = this.instanceFor(tenant);
    if (repo.hasUsers()) return false;
    repo.createUser({
      email: account.email,
      name: account.name ?? account.githubLogin ?? account.email.split('@')[0]!,
      passwordHash: '',
      role: 'owner',
      emailVerified: true,
      githubId: account.githubId,
      githubLogin: account.githubLogin,
    });
    return true;
  }

  /** Mirrors member lists of workspaces that were never mirrored (once, after an upgrade). Opens them one by one. */
  syncAllMembers(): void {
    for (const id of this.accounts.unsyncedTenantIds()) {
      const tenant = this.control.findById(id);
      if (tenant && tenant.status === 'active') this.instanceFor(tenant);
    }
  }

  stats(): CloudStats {
    return { workspaces: this.control.list().length, open: this.live.size };
  }

  /** Workspaces with notifications still waiting stay open until they've gone out (their timer lives in the instance). */
  closeIdle(now = Date.now()): void {
    for (const [id, entry] of this.live) {
      if (now - entry.lastUsed >= this.config.idleMs && !entry.instance.hasPendingNotifications()) this.evict(id);
    }
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const id of [...this.live.keys()]) this.evict(id);
    this.control.close();
  }

  private instanceFor(tenant: Tenant): Instance {
    const limitsKey = `${tenant.maxMembers}/${tenant.maxProjects}/${tenant.maxThreads}`;
    const cached = this.live.get(tenant.id);
    if (cached && cached.limitsKey === limitsKey) {
      cached.lastUsed = Date.now();
      // Map order doubles as recency order for eviction.
      this.live.delete(tenant.id);
      this.live.set(tenant.id, cached);
      return cached.instance;
    }
    if (cached) this.evict(tenant.id);
    if (this.live.size >= this.config.maxOpen) this.evict(this.live.keys().next().value!);

    const github = this.config.github ?? null;
    const instance: Instance = openInstance({
      setupToken: tenant.setupToken,
      mailer: this.mailer,
      verifiedOwnerEmail: tenant.verifiedOwnerEmail,
      onMembersChanged: () => this.accounts.syncMembers(tenant.id, instance.repo.listActiveUsers()),
      config: {
        port: this.config.port,
        databasePath: join(this.config.dataDir, 'tenants', tenant.dbFile),
        publicUrl: this.workspaceUrl(tenant.slug),
        overlayDir: this.config.overlayDir,
        trustProxy: this.config.trustProxy,
        limits: { members: tenant.maxMembers, projects: tenant.maxProjects, threads: tenant.maxThreads },
        limitsUrl: `${this.controlUrl()}/workspaces/${tenant.slug}`,
        privacyUrl: this.config.siteUrl ? `${this.config.siteUrl}/privacy` : null,
        mail: this.config.mail,
        notifyQuietMs: this.config.notifyQuietMs,
        // GitHub can't call back to every workspace, so its sign-in runs on the control plane, which hands off.
        trustedSignIn: {
          key: this.handoffKey(tenant),
          startUrl: github ? `${this.controlUrl()}/auth/github?workspace=${tenant.id}` : null,
          label: 'Continue with GitHub',
          accountUrl: `${this.controlUrl()}/login?workspace=${tenant.id}`,
        },
      },
    });
    this.accounts.syncMembers(tenant.id, instance.repo.listActiveUsers());
    this.live.set(tenant.id, { instance, limitsKey, lastUsed: Date.now() });
    return instance;
  }

  /** Keyed by workspace id, so a rename never leaves a second instance open on the same file. */
  private evict(id: string): void {
    const entry = this.live.get(id);
    if (!entry) return;
    this.live.delete(id);
    entry.instance.close();
  }
}

function isNavigation(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const mode = request.headers.get('sec-fetch-mode');
  return mode ? mode === 'navigate' : (request.headers.get('accept') ?? '').includes('text/html');
}

function hostOf(request: Request): string {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  return host.replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
}

function page(status: number, title: string, message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · OpenParley</title><style>body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#14181f;background:#fbf7ee}main{max-width:560px;margin:15vh auto;padding:0 24px}h1{font-size:24px}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" },
  });
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
