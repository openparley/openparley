import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashToken, randomToken } from '@openparley/sync';

export type TenantStatus = 'active' | 'suspended';

export interface Tenant {
  slug: string;
  name: string;
  status: TenantStatus;
  /** One-time owner setup token; useless once the workspace has an owner. */
  setupToken: string;
  maxMembers: number | null;
  maxProjects: number | null;
  maxThreads: number | null;
  createdAt: number;
  /** Null for workspaces created by an operator (CLI) rather than through sign-up. */
  plan: string | null;
  billingEmail: string | null;
  polarCustomerId: string | null;
  polarSubscriptionId: string | null;
  suspendedAt: number | null;
}

/** A sign-up between the form and the paid subscription. Reserves the slug while checkout is open. */
export interface Signup {
  id: string;
  slug: string;
  name: string;
  email: string;
  plan: string;
  /** sha-256 of the cookie in the browser that signed up; only that browser sees the setup link. */
  browserHash: string;
  createdAt: number;
  expiresAt: number;
  tenantSlug: string | null;
}

/** The newest state we've seen of a Polar subscription, so late-arriving older events are ignored. */
export interface SubscriptionState {
  id: string;
  status: string;
  productId: string;
  modifiedAt: number;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RESERVED = new Set(['cloud', 'www', 'api', 'app', 'admin', 'mail', 'status', 'docs', 'help', 'support', 'billing']);

export function slugProblem(slug: string): string | null {
  if (!SLUG.test(slug)) return 'Use 1-32 lowercase letters, digits or dashes, not starting or ending with a dash.';
  if (RESERVED.has(slug)) return `"${slug}" is reserved.`;
  return null;
}

// Append-only: never edit a migration that has shipped. `PRAGMA user_version` tracks progress.
// v1 is the schema from before migrations existed (IF NOT EXISTS keeps those databases valid).
const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS tenants (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
    setup_token TEXT NOT NULL,
    max_members INTEGER,
    max_projects INTEGER,
    created_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE tenants ADD COLUMN plan TEXT;
  ALTER TABLE tenants ADD COLUMN billing_email TEXT;
  ALTER TABLE tenants ADD COLUMN polar_customer_id TEXT;
  ALTER TABLE tenants ADD COLUMN polar_subscription_id TEXT;
  ALTER TABLE tenants ADD COLUMN suspended_at INTEGER;
  CREATE UNIQUE INDEX tenants_subscription ON tenants(polar_subscription_id) WHERE polar_subscription_id IS NOT NULL;
  CREATE TABLE signups (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    plan TEXT NOT NULL,
    browser_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    tenant_slug TEXT REFERENCES tenants(slug)
  );
  CREATE INDEX signups_slug ON signups(slug, expires_at);
  CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    product_id TEXT NOT NULL,
    modified_at INTEGER NOT NULL
  );
  CREATE TABLE billing_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE renewals (
    token_hash TEXT PRIMARY KEY,
    slug TEXT NOT NULL REFERENCES tenants(slug),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE tenants ADD COLUMN max_threads INTEGER;
  `,
];

interface Row {
  slug: string;
  name: string;
  status: TenantStatus;
  setup_token: string;
  max_members: number | null;
  max_projects: number | null;
  max_threads: number | null;
  created_at: number;
  plan: string | null;
  billing_email: string | null;
  polar_customer_id: string | null;
  polar_subscription_id: string | null;
  suspended_at: number | null;
}

const toTenant = (row: Row): Tenant => ({
  slug: row.slug,
  name: row.name,
  status: row.status,
  setupToken: row.setup_token,
  maxMembers: row.max_members,
  maxProjects: row.max_projects,
  maxThreads: row.max_threads,
  createdAt: row.created_at,
  plan: row.plan,
  billingEmail: row.billing_email,
  polarCustomerId: row.polar_customer_id,
  polarSubscriptionId: row.polar_subscription_id,
  suspendedAt: row.suspended_at,
});

interface SignupRow {
  id: string;
  slug: string;
  name: string;
  email: string;
  plan: string;
  browser_hash: string;
  created_at: number;
  expires_at: number;
  tenant_slug: string | null;
}

const toSignup = (row: SignupRow): Signup => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  email: row.email,
  plan: row.plan,
  browserHash: row.browser_hash,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  tenantSlug: row.tenant_slug,
});

export interface NewTenant {
  slug: string;
  name: string;
  maxMembers?: number | null;
  maxProjects?: number | null;
  maxThreads?: number | null;
  plan?: string | null;
  billingEmail?: string | null;
  polarCustomerId?: string | null;
  polarSubscriptionId?: string | null;
}

export interface TenantPatch {
  status?: TenantStatus;
  maxMembers?: number | null;
  maxProjects?: number | null;
  maxThreads?: number | null;
  plan?: string | null;
  billingEmail?: string | null;
  polarCustomerId?: string | null;
  polarSubscriptionId?: string | null;
}

/** The control plane's own database: workspaces with their status, limits and billing links. */
export class ControlStore {
  private readonly db: Database;

  constructor(dataDir: string) {
    mkdirSync(join(dataDir, 'tenants'), { recursive: true });
    this.db = new Database(join(dataDir, 'control.db'), { strict: true, create: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    migrate(this.db);
  }

  /** Runs `fn` in one write transaction; nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.db.inTransaction) return fn();
    return this.db.transaction(fn).immediate();
  }

  create(input: NewTenant): Tenant {
    const problem = slugProblem(input.slug);
    if (problem) throw new Error(problem);
    if (this.find(input.slug)) throw new Error(`Workspace "${input.slug}" already exists.`);
    const row: Row = {
      slug: input.slug,
      name: input.name,
      status: 'active',
      setup_token: randomToken(16),
      max_members: input.maxMembers ?? null,
      max_projects: input.maxProjects ?? null,
      max_threads: input.maxThreads ?? null,
      created_at: Date.now(),
      plan: input.plan ?? null,
      billing_email: input.billingEmail ?? null,
      polar_customer_id: input.polarCustomerId ?? null,
      polar_subscription_id: input.polarSubscriptionId ?? null,
      suspended_at: null,
    };
    this.db
      .query(
        `INSERT INTO tenants (slug, name, status, setup_token, max_members, max_projects, max_threads, created_at,
           plan, billing_email, polar_customer_id, polar_subscription_id, suspended_at)
         VALUES ($slug, $name, $status, $setup_token, $max_members, $max_projects, $max_threads, $created_at,
           $plan, $billing_email, $polar_customer_id, $polar_subscription_id, $suspended_at)`,
      )
      .run({ ...row });
    return toTenant(row);
  }

  find(slug: string): Tenant | null {
    const row = this.db.query<Row, { slug: string }>('SELECT * FROM tenants WHERE slug = $slug').get({ slug });
    return row ? toTenant(row) : null;
  }

  findBySubscription(subscriptionId: string): Tenant | null {
    const row = this.db.query<Row, { id: string }>('SELECT * FROM tenants WHERE polar_subscription_id = $id').get({ id: subscriptionId });
    return row ? toTenant(row) : null;
  }

  list(): Tenant[] {
    return this.db.query<Row, []>('SELECT * FROM tenants ORDER BY created_at').all().map(toTenant);
  }

  update(slug: string, patch: TenantPatch): void {
    const tenant = this.find(slug);
    if (!tenant) throw new Error(`No workspace "${slug}".`);
    const status = patch.status ?? tenant.status;
    const pick = <K extends keyof TenantPatch & keyof Tenant>(key: K) => (patch[key] === undefined ? tenant[key] : patch[key]);
    this.db
      .query(
        `UPDATE tenants SET status = $status, max_members = $maxMembers, max_projects = $maxProjects, max_threads = $maxThreads, plan = $plan,
           billing_email = $billingEmail, polar_customer_id = $customer, polar_subscription_id = $subscription,
           suspended_at = $suspendedAt WHERE slug = $slug`,
      )
      .run({
        slug,
        status,
        maxMembers: pick('maxMembers'),
        maxProjects: pick('maxProjects'),
        maxThreads: pick('maxThreads'),
        plan: pick('plan'),
        billingEmail: pick('billingEmail'),
        customer: pick('polarCustomerId'),
        subscription: pick('polarSubscriptionId'),
        suspendedAt: status === 'active' ? null : status === tenant.status ? tenant.suspendedAt : Date.now(),
      });
  }

  // --- sign-ups ------------------------------------------------------------

  createSignup(input: Omit<Signup, 'id' | 'createdAt' | 'tenantSlug'>): Signup {
    const signup: Signup = { ...input, id: randomToken(16), createdAt: Date.now(), tenantSlug: null };
    this.db
      .query(
        `INSERT INTO signups (id, slug, name, email, plan, browser_hash, created_at, expires_at, tenant_slug)
         VALUES ($id, $slug, $name, $email, $plan, $browserHash, $createdAt, $expiresAt, NULL)`,
      )
      .run({ id: signup.id, slug: signup.slug, name: signup.name, email: signup.email, plan: signup.plan, browserHash: signup.browserHash, createdAt: signup.createdAt, expiresAt: signup.expiresAt });
    return signup;
  }

  findSignup(id: string): Signup | null {
    const row = this.db.query<SignupRow, { id: string }>('SELECT * FROM signups WHERE id = $id').get({ id });
    return row ? toSignup(row) : null;
  }

  setSignupExpiry(id: string, expiresAt: number): void {
    this.db.query('UPDATE signups SET expires_at = $expiresAt WHERE id = $id').run({ id, expiresAt });
  }

  /** The newest unconfirmed, unexpired free sign-up for an address (support: "I never got the email"). */
  pendingFreeSignup(slug: string, now = Date.now()): Signup | null {
    const row = this.db
      .query<SignupRow, { slug: string; now: number }>(
        "SELECT * FROM signups WHERE slug = $slug AND plan = 'free' AND tenant_slug IS NULL AND expires_at > $now ORDER BY created_at DESC LIMIT 1",
      )
      .get({ slug, now });
    return row ? toSignup(row) : null;
  }

  completeSignup(id: string, tenantSlug: string): void {
    this.db.query('UPDATE signups SET tenant_slug = $tenantSlug WHERE id = $id').run({ id, tenantSlug });
  }

  /** Whether a slug is free: no workspace, and no open checkout from another browser holds it. */
  slugAvailable(slug: string, browserHash: string | null, now = Date.now()): boolean {
    if (this.find(slug)) return false;
    const held = this.db
      .query<{ n: number }, { slug: string; now: number; browserHash: string }>(
        'SELECT COUNT(*) AS n FROM signups WHERE slug = $slug AND expires_at > $now AND tenant_slug IS NULL AND browser_hash != $browserHash',
      )
      .get({ slug, now, browserHash: browserHash ?? '' })!;
    return held.n === 0;
  }

  // --- billing -------------------------------------------------------------

  /** Records a webhook delivery. False if it was already processed (Polar retries deliveries). */
  recordEvent(id: string, type: string, payload: string): boolean {
    const result = this.db
      .query('INSERT INTO billing_events (id, type, received_at, payload) VALUES ($id, $type, $receivedAt, $payload) ON CONFLICT (id) DO NOTHING')
      .run({ id, type, receivedAt: Date.now(), payload });
    return result.changes === 1;
  }

  eventCount(): number {
    return this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM billing_events').get()!.n;
  }

  /** Stores the subscription state unless we've already seen a newer one. Returns whether it was applied. */
  recordSubscription(state: SubscriptionState): boolean {
    const result = this.db
      .query(
        `INSERT INTO subscriptions (id, status, product_id, modified_at) VALUES ($id, $status, $productId, $modifiedAt)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, product_id = excluded.product_id, modified_at = excluded.modified_at
         WHERE excluded.modified_at >= subscriptions.modified_at`,
      )
      .run({ ...state });
    return result.changes === 1;
  }

  findSubscription(id: string): SubscriptionState | null {
    return (
      this.db
        .query<SubscriptionState, { id: string }>('SELECT id, status, product_id AS productId, modified_at AS modifiedAt FROM subscriptions WHERE id = $id')
        .get({ id }) ?? null
    );
  }

  // --- renewal links ---------------------------------------------------------

  /** A link token that lets whoever reads the billing email renew a paused workspace. */
  createRenewal(slug: string, ttlMs: number): string {
    const token = randomToken();
    const now = Date.now();
    this.db.query('DELETE FROM renewals WHERE expires_at <= $now').run({ now });
    this.db
      .query('INSERT INTO renewals (token_hash, slug, created_at, expires_at) VALUES ($hash, $slug, $now, $expiresAt)')
      .run({ hash: hashToken(token), slug, now, expiresAt: now + ttlMs });
    return token;
  }

  /** The workspace a renewal token is for, while the token is unexpired. */
  renewalSlug(token: string, now = Date.now()): string | null {
    const row = this.db
      .query<{ slug: string }, { hash: string; now: number }>('SELECT slug FROM renewals WHERE token_hash = $hash AND expires_at > $now')
      .get({ hash: hashToken(token), now });
    return row?.slug ?? null;
  }

  close(): void {
    this.db.close();
  }
}

function migrate(db: Database): void {
  const { user_version: current } = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!;
  if (current > MIGRATIONS.length) {
    throw new Error(`control.db schema v${current} is newer than this server (v${MIGRATIONS.length}). Upgrade the server.`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}
