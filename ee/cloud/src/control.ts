import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashToken, randomToken } from '@openparley/sync';

export type TenantStatus = 'active' | 'suspended';

const ABANDONED_SIGNUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface Tenant {
  /** Never changes. Everything that must survive a rename (database file, agent tokens, memberships) uses it. */
  id: string;
  /** The address, `<slug>.<domain>`. */
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
  /** File name under `tenants/`: the slug for workspaces from before ids, the id since. */
  dbFile: string;
  /** An address confirmed at sign-up; an owner who sets up with it starts with a confirmed email. */
  verifiedOwnerEmail: string | null;
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
  /** Signed up while signed in to a Cloud account: that account becomes the owner, no setup link needed. */
  accountId: string | null;
}

/** The newest state we've seen of a Polar subscription, so late-arriving older events are ignored. */
export interface SubscriptionState {
  id: string;
  status: string;
  productId: string;
  modifiedAt: number;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// Hostnames Cloud uses or may use itself. Adding a name is safe only while no workspace has it (check `cloud list`).
const RESERVED = new Set([
  'cloud', 'www', 'api', 'app', 'admin', 'mail', 'status', 'docs', 'help', 'support', 'billing',
  'mcp', 'auth', 'login', 'signup', 'oauth', 'github', 'account', 'accounts', 'id', 'static', 'assets', 'cdn', 'openparley',
]);

/** An address from a name: `Café Acme, Inc.` → `cafe-acme-inc`. Never empty. */
export function slugFrom(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug || 'workspace';
}

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
  `
  ALTER TABLE tenants ADD COLUMN id TEXT;
  ALTER TABLE tenants ADD COLUMN db_file TEXT;
  UPDATE tenants SET id = lower(hex(randomblob(12))), db_file = slug || '.db';
  CREATE UNIQUE INDEX tenants_id ON tenants(id);
  `,
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    github_id TEXT UNIQUE,
    github_login TEXT,
    name TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE account_sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX account_sessions_account ON account_sessions(account_id);
  CREATE TABLE sign_in_links (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    next TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE memberships (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email TEXT COLLATE NOCASE,
    github_id TEXT,
    role TEXT NOT NULL,
    PRIMARY KEY (tenant_id, user_id)
  );
  CREATE INDEX memberships_email ON memberships(email);
  CREATE INDEX memberships_github ON memberships(github_id);
  CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  ALTER TABLE tenants ADD COLUMN members_synced_at INTEGER;
  ALTER TABLE tenants ADD COLUMN verified_owner_email TEXT;
  ALTER TABLE signups ADD COLUMN account_id TEXT;
  CREATE TABLE tenant_aliases (
    slug TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE mcp_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    secret_hash TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE mcp_workspace_clients (
    mcp_client_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    workspace_client_id TEXT NOT NULL,
    PRIMARY KEY (mcp_client_id, tenant_id)
  );
  CREATE TABLE mcp_requests (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    state TEXT,
    code_challenge TEXT NOT NULL,
    tenant_id TEXT,
    verifier TEXT,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE mcp_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    sealed TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
];

interface Row {
  id: string;
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
  db_file: string;
  verified_owner_email: string | null;
}

const toTenant = (row: Row): Tenant => ({
  id: row.id,
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
  dbFile: row.db_file,
  verifiedOwnerEmail: row.verified_owner_email,
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
  account_id: string | null;
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
  accountId: row.account_id,
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
  verifiedOwnerEmail?: string | null;
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
  /** Shared with `AccountStore`, which keeps its tables in the same file. */
  readonly db: Database;

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
    if (this.find(input.slug) || this.aliasOf(input.slug)) throw new Error(`Workspace "${input.slug}" already exists.`);
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('hex');
    const row: Row = {
      id,
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
      db_file: `${id}.db`,
      verified_owner_email: input.verifiedOwnerEmail ?? null,
    };
    this.db
      .query(
        `INSERT INTO tenants (id, slug, name, status, setup_token, max_members, max_projects, max_threads, created_at,
           plan, billing_email, polar_customer_id, polar_subscription_id, suspended_at, db_file, verified_owner_email)
         VALUES ($id, $slug, $name, $status, $setup_token, $max_members, $max_projects, $max_threads, $created_at,
           $plan, $billing_email, $polar_customer_id, $polar_subscription_id, $suspended_at, $db_file, $verified_owner_email)`,
      )
      .run({ ...row });
    return toTenant(row);
  }

  find(slug: string): Tenant | null {
    const row = this.db.query<Row, { slug: string }>('SELECT * FROM tenants WHERE slug = $slug').get({ slug });
    return row ? toTenant(row) : null;
  }

  /** The workspace an old address (from before a rename) belongs to. */
  aliasOf(slug: string): Tenant | null {
    const row = this.db.query<Row, { slug: string }>('SELECT t.* FROM tenant_aliases a JOIN tenants t ON t.id = a.tenant_id WHERE a.slug = $slug').get({ slug });
    return row ? toTenant(row) : null;
  }

  /**
   * Gives a workspace a new address. The old one stays an alias (forever: it's in script tags and
   * share links), so nobody else can take it. Renaming back to an old address takes it back.
   */
  rename(id: string, slug: string): Tenant {
    const problem = slugProblem(slug);
    if (problem) throw new Error(problem);
    return this.transaction(() => {
      const tenant = this.findById(id);
      if (!tenant) throw new Error('No such workspace.');
      if (tenant.slug === slug) return tenant;
      const alias = this.aliasOf(slug);
      const ownAlias = alias?.id === id;
      if (this.find(slug) || (alias && !ownAlias) || (!ownAlias && !this.slugAvailable(slug, null))) throw new Error(`${slug} is already taken.`);
      // Sign-ups and renewal links name the workspace by slug; they move along in the same transaction.
      this.db.exec('PRAGMA defer_foreign_keys = ON');
      this.db.query('DELETE FROM tenant_aliases WHERE slug = $slug').run({ slug });
      this.db.query('INSERT INTO tenant_aliases (slug, tenant_id, created_at) VALUES ($old, $id, $now)').run({ old: tenant.slug, id, now: Date.now() });
      this.db.query('UPDATE tenants SET slug = $slug WHERE id = $id').run({ slug, id });
      this.db.query('UPDATE signups SET tenant_slug = $slug WHERE tenant_slug = $old').run({ slug, old: tenant.slug });
      this.db.query('UPDATE renewals SET slug = $slug WHERE slug = $old').run({ slug, old: tenant.slug });
      return this.findById(id)!;
    });
  }

  findById(id: string): Tenant | null {
    const row = this.db.query<Row, { id: string }>('SELECT * FROM tenants WHERE id = $id').get({ id });
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

  createSignup(input: Omit<Signup, 'id' | 'createdAt' | 'tenantSlug' | 'accountId'> & { accountId?: string | null }): Signup {
    const signup: Signup = { ...input, accountId: input.accountId ?? null, id: randomToken(16), createdAt: Date.now(), tenantSlug: null };
    // The privacy policy promises this retention for sign-ups that never became a workspace. The margin
    // past expiry leaves room for a late Polar webhook to still find its sign-up.
    this.db
      .query('DELETE FROM signups WHERE tenant_slug IS NULL AND expires_at <= $cutoff')
      .run({ cutoff: signup.createdAt - ABANDONED_SIGNUP_RETENTION_MS });
    this.db
      .query(
        `INSERT INTO signups (id, slug, name, email, plan, browser_hash, created_at, expires_at, tenant_slug, account_id)
         VALUES ($id, $slug, $name, $email, $plan, $browserHash, $createdAt, $expiresAt, NULL, $accountId)`,
      )
      .run({
        id: signup.id,
        slug: signup.slug,
        name: signup.name,
        email: signup.email,
        plan: signup.plan,
        browserHash: signup.browserHash,
        createdAt: signup.createdAt,
        expiresAt: signup.expiresAt,
        accountId: signup.accountId,
      });
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
    if (this.find(slug) || this.aliasOf(slug)) return false;
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

  /** A secret generated on first use and kept in control.db (e.g. the key behind sign-in hand-offs). */
  secret(name: string): string {
    this.db.query('INSERT INTO secrets (name, value) VALUES ($name, $value) ON CONFLICT DO NOTHING').run({ name, value: randomToken(32) });
    return this.db.query<{ value: string }, { name: string }>('SELECT value FROM secrets WHERE name = $name').get({ name })!.value;
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
