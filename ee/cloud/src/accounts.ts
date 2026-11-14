import type { Database } from 'bun:sqlite';
import { hashToken, randomToken, type Identity, type User } from '@openparley/sync';

export const ACCOUNT_SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
export const SIGN_IN_LINK_TTL = 30 * 60 * 1000;

/**
 * Someone with an OpenParley Cloud sign-in: a confirmed email, maybe a GitHub account. Not a user of
 * any workspace: those stay inside each workspace's own database. An account sees the workspaces
 * whose members have its GitHub id or its (confirmed) email.
 */
export interface Account {
  id: string;
  email: string;
  githubId: string | null;
  githubLogin: string | null;
  name: string | null;
  createdAt: number;
}

export interface Membership {
  tenantId: string;
  userId: string;
  role: string;
}

interface AccountRow {
  id: string;
  email: string;
  github_id: string | null;
  github_login: string | null;
  name: string | null;
  created_at: number;
}

const toAccount = (row: AccountRow): Account => ({
  id: row.id,
  email: row.email,
  githubId: row.github_id,
  githubLogin: row.github_login,
  name: row.name,
  createdAt: row.created_at,
});

/** Accounts, their sessions and sign-in links, and the mirror of who belongs to which workspace. Lives in control.db. */
export class AccountStore {
  constructor(private readonly db: Database) {}

  find(id: string): Account | null {
    const row = this.db.query<AccountRow, { id: string }>('SELECT * FROM accounts WHERE id = $id').get({ id });
    return row ? toAccount(row) : null;
  }

  findByEmail(email: string): Account | null {
    const row = this.db.query<AccountRow, { email: string }>('SELECT * FROM accounts WHERE email = $email').get({ email });
    return row ? toAccount(row) : null;
  }

  /**
   * The account for someone GitHub vouched for: by GitHub id, else the account with one of their
   * verified emails (which then gets GitHub linked), else a new one. Null without a verified email.
   */
  fromGithub(identity: Identity & { verifiedEmails?: string[] }): Account | null {
    if (!identity.githubId || !identity.email || !identity.emailVerified) return null;
    const patch = { githubId: identity.githubId, githubLogin: identity.githubLogin ?? null, name: identity.name ?? null };
    const byGithub = this.db.query<AccountRow, { githubId: string }>('SELECT * FROM accounts WHERE github_id = $githubId').get({ githubId: identity.githubId });
    if (byGithub) {
      this.db.query('UPDATE accounts SET github_login = $githubLogin, name = COALESCE(name, $name) WHERE id = $id').run({ id: byGithub.id, ...patch });
      return this.find(byGithub.id);
    }
    for (const email of identity.verifiedEmails ?? [identity.email]) {
      const existing = this.findByEmail(email);
      if (existing && !existing.githubId) {
        this.db.query('UPDATE accounts SET github_id = $githubId, github_login = $githubLogin, name = COALESCE(name, $name) WHERE id = $id').run({ id: existing.id, ...patch });
        return this.find(existing.id);
      }
    }
    if (this.findByEmail(identity.email)) return null;
    return this.create(identity.email, patch);
  }

  /** The account for a confirmed email (an emailed sign-in link was used). */
  fromEmail(email: string): Account {
    return this.findByEmail(email) ?? this.create(email, { githubId: null, githubLogin: null, name: null });
  }

  private create(email: string, fields: { githubId: string | null; githubLogin: string | null; name: string | null }): Account {
    const row: AccountRow = { id: randomToken(12), email: email.toLowerCase(), github_id: fields.githubId, github_login: fields.githubLogin, name: fields.name, created_at: Date.now() };
    this.db
      .query('INSERT INTO accounts (id, email, github_id, github_login, name, created_at) VALUES ($id, $email, $github_id, $github_login, $name, $created_at)')
      .run({ ...row });
    return toAccount(row);
  }

  // --- sessions ------------------------------------------------------------

  createSession(accountId: string): string {
    const token = randomToken();
    const now = Date.now();
    this.db.query('DELETE FROM account_sessions WHERE expires_at <= $now').run({ now });
    this.db.query('INSERT INTO account_sessions (token_hash, account_id, expires_at) VALUES ($hash, $accountId, $expiresAt)').run({ hash: hashToken(token), accountId, expiresAt: now + ACCOUNT_SESSION_TTL });
    return token;
  }

  accountForSession(token: string): Account | null {
    const row = this.db
      .query<AccountRow, { hash: string; now: number }>(
        'SELECT accounts.* FROM account_sessions JOIN accounts ON accounts.id = account_sessions.account_id WHERE token_hash = $hash AND expires_at > $now',
      )
      .get({ hash: hashToken(token), now: Date.now() });
    return row ? toAccount(row) : null;
  }

  deleteSession(token: string): void {
    this.db.query('DELETE FROM account_sessions WHERE token_hash = $hash').run({ hash: hashToken(token) });
  }

  // --- emailed sign-in links -------------------------------------------------

  createSignInLink(email: string, next: string): string {
    const token = randomToken();
    const now = Date.now();
    this.db.query('DELETE FROM sign_in_links WHERE expires_at <= $now').run({ now });
    this.db.query('INSERT INTO sign_in_links (token_hash, email, next, expires_at) VALUES ($hash, $email, $next, $expiresAt)').run({ hash: hashToken(token), email: email.toLowerCase(), next, expiresAt: now + SIGN_IN_LINK_TTL });
    return token;
  }

  /** Single use: the email it proves and where it was going. */
  useSignInLink(token: string): { email: string; next: string } | null {
    return (
      this.db
        .query<{ email: string; next: string }, { hash: string; now: number }>('DELETE FROM sign_in_links WHERE token_hash = $hash AND expires_at > $now RETURNING email, next')
        .get({ hash: hashToken(token), now: Date.now() }) ?? null
    );
  }

  // --- who belongs where -----------------------------------------------------

  /** Replaces a workspace's mirrored member list. Only confirmed emails are kept: an unconfirmed one matches nobody. */
  syncMembers(tenantId: string, users: User[]): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM memberships WHERE tenant_id = $tenantId').run({ tenantId });
      const insert = this.db.query('INSERT INTO memberships (tenant_id, user_id, email, github_id, role) VALUES ($tenantId, $userId, $email, $githubId, $role)');
      for (const user of users) {
        insert.run({ tenantId, userId: user.id, email: user.emailVerified ? user.email.toLowerCase() : null, githubId: user.githubId, role: user.role });
      }
      this.db.query('UPDATE tenants SET members_synced_at = $now WHERE id = $tenantId').run({ tenantId, now: Date.now() });
    })();
  }

  /** The workspaces this account belongs to, oldest first. */
  memberships(account: Account): Membership[] {
    return this.db
      .query<{ tenant_id: string; user_id: string; role: string }, { email: string; githubId: string }>(
        `SELECT m.tenant_id, m.user_id, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.email = $email OR (m.github_id IS NOT NULL AND m.github_id = $githubId)
         GROUP BY m.tenant_id ORDER BY t.created_at`,
      )
      .all({ email: account.email, githubId: account.githubId ?? '' })
      .map((row) => ({ tenantId: row.tenant_id, userId: row.user_id, role: row.role }));
  }

  /** Workspaces whose member list was never mirrored (from before accounts existed). */
  unsyncedTenantIds(): string[] {
    return this.db.query<{ id: string }, []>('SELECT id FROM tenants WHERE members_synced_at IS NULL').all().map((row) => row.id);
  }
}
