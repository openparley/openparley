import type { Database } from 'bun:sqlite';
import type { Anchor, Author, Comment, Role, Thread, ThreadStatus } from '@openparley/protocol';
import { hashToken, openWithToken, randomId, randomToken, sealWithToken } from './crypto';
import { allows } from './origins';

export interface User {
  id: string;
  email: string;
  name: string;
  /** Mention name, `@handle` in comments. Unique among everyone who ever had an account, so an old mention never points at someone new. */
  handle: string;
  role: Role;
  passwordHash: string;
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  origins: string[];
  createdAt: number;
}

export interface Invite {
  id: string;
  role: Exclude<Role, 'owner'>;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  /** Who it was sent to, when the admin entered an address. */
  email: string | null;
}

type InviteRow = { id: string; role: Invite['role']; created_by: string; created_at: number; expires_at: number; email: string | null };
const toInvite = (row: InviteRow): Invite => ({
  id: row.id,
  role: row.role,
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  email: row.email,
});

export type SessionKind = 'web' | 'api';

/**
 * An agent (e.g. a coding assistant over MCP) acting for its user: either a long-lived token pasted
 * into the agent's config, or an OAuth sign-in (`clientId` set) with short-lived rotating tokens.
 */
export interface AgentToken {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  clientId: string | null;
}

/** Prefix of agent tokens, so they're recognisable in config files and secret scanners. */
export const AGENT_TOKEN_PREFIX = 'opa_';
export const REFRESH_TOKEN_PREFIX = 'opr_';

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  /** Null for public clients (the usual case for coding agents), which prove themselves with PKCE alone. */
  secretHash: string | null;
  createdAt: number;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type NotifyLevel = 'off' | 'mentions' | 'participating' | 'everything';
export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['off', 'mentions', 'participating', 'everything'];
export const DEFAULT_NOTIFY_LEVEL: NotifyLevel = 'participating';

export interface NotificationSettings {
  /** What the user hears about in projects without an override. */
  level: NotifyLevel;
  projects: Record<string, NotifyLevel>;
  /** Explicit switches per channel; a channel without one uses its own default. */
  channels: Record<string, boolean>;
}

/** One event waiting to be delivered to one person. */
export interface PendingNotification {
  id: number;
  userId: string;
  threadId: string;
  /** The comment it's about; null for status changes. */
  commentId: string | null;
  event: 'comment' | 'resolved' | 'reopened';
  /** The recipient was @mentioned in the comment. */
  mention: boolean;
  actorId: string;
  agent: string | null;
  attempts: number;
  createdAt: number;
}

type PendingRow = {
  id: number;
  user_id: string;
  thread_id: string;
  comment_id: string | null;
  event: PendingNotification['event'];
  mention: number;
  actor_id: string;
  agent: string | null;
  attempts: number;
  created_at: number;
};

const DAY = 24 * 60 * 60 * 1000;
export const ACCESS_TOKEN_TTL = 60 * 60 * 1000;
/** Sliding: every refresh starts it again, so an agent in regular use stays signed in. */
export const REFRESH_TOKEN_TTL = 90 * DAY;
/**
 * How long a refresh token that was just rotated still gets the same answer again. Clients refresh in
 * parallel (several sessions waking up together) or retry when the answer got lost; without this the
 * second request fails and the client throws away the sign-in.
 */
export const REFRESH_REPLAY_TTL = 2 * 60 * 1000;
export const OAUTH_CODE_TTL = 5 * 60 * 1000;
/** Registrations that never led to a sign-in are dropped after this. */
const UNUSED_CLIENT_TTL = 7 * DAY;
export const SESSION_TTL = 30 * DAY;
export const INVITE_TTL = 7 * DAY;

interface UserRow {
  id: string;
  email: string;
  name: string;
  handle: string | null;
  role: Role;
  password_hash: string;
  created_at: number;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  handle: row.handle ?? '',
  role: row.role,
  passwordHash: row.password_hash,
  createdAt: row.created_at,
});

/** All persistence for one OpenParley instance (= one organization). */
export class Repo {
  constructor(private readonly db: Database) {
    // Accounts from before mention names existed get one on first open.
    const missing = db.query<{ id: string; name: string }, []>('SELECT id, name FROM users WHERE handle IS NULL ORDER BY created_at').all();
    for (const user of missing) db.query('UPDATE users SET handle = $handle WHERE id = $id').run({ id: user.id, handle: this.freeHandle(user.name) });
  }

  // --- users -------------------------------------------------------------

  hasUsers(): boolean {
    return this.db.query('SELECT 1 FROM users LIMIT 1').get() !== null;
  }

  createUser(input: { email: string; name: string; passwordHash: string; role: Role }): User {
    const user: UserRow = {
      id: randomId(),
      email: input.email,
      name: input.name,
      handle: this.freeHandle(input.name),
      role: input.role,
      password_hash: input.passwordHash,
      created_at: Date.now(),
    };
    this.db
      .query(
        'INSERT INTO users (id, email, name, handle, password_hash, role, created_at) VALUES ($id, $email, $name, $handle, $password_hash, $role, $created_at)',
      )
      .run({ ...user });
    return toUser(user);
  }

  findActiveUserByEmail(email: string): User | null {
    const row = this.db.query<UserRow, { email: string }>('SELECT * FROM users WHERE email = $email AND removed_at IS NULL').get({ email });
    return row ? toUser(row) : null;
  }

  emailTaken(email: string): boolean {
    return this.db.query('SELECT 1 FROM users WHERE email = $email').get({ email }) !== null;
  }

  listActiveUsers(): User[] {
    return this.db.query<UserRow, []>('SELECT * FROM users WHERE removed_at IS NULL ORDER BY created_at').all().map(toUser);
  }

  findActiveUser(id: string): User | null {
    const row = this.db.query<UserRow, { id: string }>('SELECT * FROM users WHERE id = $id AND removed_at IS NULL').get({ id });
    return row ? toUser(row) : null;
  }

  /** False when someone else has (or had) it. */
  setHandle(userId: string, handle: string): boolean {
    const taken = this.db.query('SELECT 1 FROM users WHERE handle = $handle AND id != $userId').get({ handle, userId });
    if (taken) return false;
    this.db.query('UPDATE users SET handle = $handle WHERE id = $userId').run({ handle, userId });
    return true;
  }

  /** `mia`, else `mia.designer`, else `mia2`, `mia3`… */
  private freeHandle(name: string): string {
    const words = name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const first = (words[0] ?? 'member').slice(0, 24);
    const taken = (handle: string) => this.db.query('SELECT 1 FROM users WHERE handle = $handle').get({ handle }) !== null;
    for (const candidate of [first, words.join('.').slice(0, 30)]) if (!taken(candidate)) return candidate;
    for (let n = 2; ; n++) if (!taken(`${first}${n}`)) return `${first}${n}`;
  }

  /** Also for removed users, whose name stays on what they wrote. */
  userName(id: string): string | null {
    return this.db.query<{ name: string }, { id: string }>('SELECT name FROM users WHERE id = $id').get({ id })?.name ?? null;
  }

  setRole(userId: string, role: Exclude<Role, 'owner'>): void {
    this.db.query("UPDATE users SET role = $role WHERE id = $id AND role != 'owner'").run({ id: userId, role });
  }

  /** Removed users keep their name on past comments but can no longer sign in. */
  removeUser(userId: string): void {
    this.db.transaction(() => {
      this.db.query("UPDATE users SET removed_at = $now WHERE id = $id AND role != 'owner'").run({ id: userId, now: Date.now() });
      this.db.query('DELETE FROM sessions WHERE user_id = $id').run({ id: userId });
      this.db.query('DELETE FROM agent_tokens WHERE user_id = $id').run({ id: userId });
    })();
  }

  // --- agent tokens ------------------------------------------------------

  createAgentToken(userId: string, name: string): { agent: AgentToken; token: string } {
    const token = `${AGENT_TOKEN_PREFIX}${randomToken()}`;
    const agent: AgentToken = { id: randomId(), userId, name, createdAt: Date.now(), lastUsedAt: null, clientId: null };
    this.db
      .query('INSERT INTO agent_tokens (id, user_id, name, token_hash, created_at) VALUES ($id, $userId, $name, $hash, $createdAt)')
      .run({ id: agent.id, userId, name, hash: hashToken(token), createdAt: agent.createdAt });
    return { agent, token };
  }

  listAgentTokens(userId: string): AgentToken[] {
    return this.db
      .query<{ id: string; user_id: string; name: string; created_at: number; last_used_at: number | null; client_id: string | null }, { userId: string; now: number }>(
        `SELECT id, user_id, name, created_at, last_used_at, client_id FROM agent_tokens
         WHERE user_id = $userId AND (refresh_expires_at IS NULL OR refresh_expires_at > $now) ORDER BY created_at`,
      )
      .all({ userId, now: Date.now() })
      .map((row) => ({ id: row.id, userId: row.user_id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at, clientId: row.client_id }));
  }

  /** Only the token's own user can revoke it. */
  deleteAgentToken(id: string, userId: string): void {
    this.db.query('DELETE FROM agent_tokens WHERE id = $id AND user_id = $userId').run({ id, userId });
  }

  /** The user and agent a token belongs to (records the use), or null for unknown tokens and removed users. */
  agentForToken(token: string): { user: User; agent: AgentToken } | null {
    if (!token.startsWith(AGENT_TOKEN_PREFIX)) return null;
    const row = this.db
      .query<UserRow & { agent_id: string; agent_name: string; agent_created_at: number; client_id: string | null }, { hash: string; now: number }>(
        `SELECT users.*, a.id AS agent_id, a.name AS agent_name, a.created_at AS agent_created_at, a.client_id
         FROM agent_tokens a JOIN users ON users.id = a.user_id
         WHERE a.token_hash = $hash AND (a.token_expires_at IS NULL OR a.token_expires_at > $now) AND users.removed_at IS NULL`,
      )
      .get({ hash: hashToken(token), now: Date.now() });
    if (!row) return null;
    const now = Date.now();
    this.db.query('UPDATE agent_tokens SET last_used_at = $now WHERE id = $id').run({ id: row.agent_id, now });
    return {
      user: toUser(row),
      agent: { id: row.agent_id, userId: row.id, name: row.agent_name, createdAt: row.agent_created_at, lastUsedAt: now, clientId: row.client_id },
    };
  }

  // --- OAuth (agents signing in instead of pasting a token) ---------------

  registerOAuthClient(input: { name: string; redirectUris: string[]; confidential: boolean }): { client: OAuthClient; secret: string | null } {
    this.sweepOAuth();
    const secret = input.confidential ? randomToken() : null;
    const client: OAuthClient = { id: randomId(), name: input.name, redirectUris: input.redirectUris, secretHash: secret && hashToken(secret), createdAt: Date.now() };
    this.db
      .query('INSERT INTO oauth_clients (id, name, redirect_uris, secret_hash, created_at) VALUES ($id, $name, $uris, $secretHash, $createdAt)')
      .run({ id: client.id, name: client.name, uris: JSON.stringify(client.redirectUris), secretHash: client.secretHash, createdAt: client.createdAt });
    return { client, secret };
  }

  findOAuthClient(id: string): OAuthClient | null {
    const row = this.db
      .query<{ id: string; name: string; redirect_uris: string; secret_hash: string | null; created_at: number }, { id: string }>(
        'SELECT * FROM oauth_clients WHERE id = $id',
      )
      .get({ id });
    return row && { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris), secretHash: row.secret_hash, createdAt: row.created_at };
  }

  createOAuthCode(input: { clientId: string; userId: string; agentName: string; redirectUri: string; codeChallenge: string }): string {
    const code = randomToken();
    this.db
      .query(
        `INSERT INTO oauth_codes (code_hash, client_id, user_id, agent_name, redirect_uri, code_challenge, expires_at)
         VALUES ($hash, $clientId, $userId, $agentName, $redirectUri, $codeChallenge, $expiresAt)`,
      )
      .run({ ...input, hash: hashToken(code), expiresAt: Date.now() + OAUTH_CODE_TTL });
    return code;
  }

  /** Codes work once: the code is gone after this, whether or not the caller accepts it. */
  takeOAuthCode(code: string): { clientId: string; userId: string; agentName: string; redirectUri: string; codeChallenge: string } | null {
    const row = this.db
      .query<
        { client_id: string; user_id: string; agent_name: string; redirect_uri: string; code_challenge: string; expires_at: number },
        { hash: string }
      >('DELETE FROM oauth_codes WHERE code_hash = $hash RETURNING client_id, user_id, agent_name, redirect_uri, code_challenge, expires_at')
      .get({ hash: hashToken(code) });
    if (!row || row.expires_at <= Date.now()) return null;
    return { clientId: row.client_id, userId: row.user_id, agentName: row.agent_name, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge };
  }

  /** Signing in again with the same client replaces its earlier sign-in, so the Agents list doesn't fill with duplicates. */
  createOAuthAgent(userId: string, clientId: string, name: string): OAuthTokens | null {
    const user = this.db.query<{ id: string }, { id: string }>('SELECT id FROM users WHERE id = $id AND removed_at IS NULL').get({ id: userId });
    if (!user) return null;
    const id = randomId();
    const tokens = this.newOAuthTokens();
    this.db.transaction(() => {
      this.db.query('DELETE FROM agent_tokens WHERE user_id = $userId AND client_id = $clientId').run({ userId, clientId });
      this.db
        .query(
          `INSERT INTO agent_tokens (id, user_id, name, token_hash, created_at, client_id, token_expires_at, refresh_hash, refresh_expires_at)
           VALUES ($id, $userId, $name, $tokenHash, $now, $clientId, $tokenExpiresAt, $refreshHash, $refreshExpiresAt)`,
        )
        .run({ id, userId, name, clientId, now: Date.now(), ...tokens.stored });
    })();
    return tokens.issued;
  }

  /**
   * Rotates both tokens; the old refresh token stops working, except that for `REFRESH_REPLAY_TTL`
   * it gets the very same tokens again (not new ones, which would cut off whoever got the first answer).
   */
  refreshOAuthAgent(refreshToken: string, clientId: string): OAuthTokens | null {
    if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return null;
    const old = hashToken(refreshToken);
    const now = Date.now();
    return this.db.transaction((): OAuthTokens | null => {
      const row = this.db
        .query<
          { id: string; refresh_hash: string; token_expires_at: number; previous_refresh_until: number | null; previous_response: string | null },
          { old: string; clientId: string; now: number }
        >(
          `SELECT id, refresh_hash, token_expires_at, previous_refresh_until, previous_response FROM agent_tokens
           WHERE (refresh_hash = $old OR previous_refresh_hash = $old) AND client_id = $clientId AND refresh_expires_at > $now
             AND user_id IN (SELECT id FROM users WHERE removed_at IS NULL)`,
        )
        .get({ old, clientId, now });
      if (!row) return null;
      if (row.refresh_hash !== old) {
        if (!row.previous_response || (row.previous_refresh_until ?? 0) <= now) return null;
        const replay = openWithToken(refreshToken, row.previous_response);
        if (!replay) return null;
        const { accessToken, refreshToken: next } = JSON.parse(replay) as { accessToken: string; refreshToken: string };
        return { accessToken, refreshToken: next, expiresIn: Math.max(0, Math.floor((row.token_expires_at - now) / 1000)) };
      }
      const tokens = this.newOAuthTokens();
      const response = JSON.stringify({ accessToken: tokens.issued.accessToken, refreshToken: tokens.issued.refreshToken });
      this.db
        .query(
          `UPDATE agent_tokens SET token_hash = $tokenHash, token_expires_at = $tokenExpiresAt, refresh_hash = $refreshHash, refresh_expires_at = $refreshExpiresAt,
             previous_refresh_hash = $old, previous_refresh_until = $replayUntil, previous_response = $response
           WHERE id = $id`,
        )
        .run({ ...tokens.stored, old, replayUntil: now + REFRESH_REPLAY_TTL, response: sealWithToken(refreshToken, response), id: row.id });
      return tokens.issued;
    })();
  }

  /** Ends an OAuth sign-in by either of its tokens (RFC 7009). Pasted agent tokens are only revoked from the admin page. */
  revokeOAuthToken(token: string, clientId: string): void {
    this.db
      .query('DELETE FROM agent_tokens WHERE client_id = $clientId AND (token_hash = $hash OR refresh_hash = $hash)')
      .run({ hash: hashToken(token), clientId });
  }

  private newOAuthTokens() {
    const accessToken = `${AGENT_TOKEN_PREFIX}${randomToken()}`;
    const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomToken()}`;
    const now = Date.now();
    return {
      issued: { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL / 1000 },
      stored: {
        tokenHash: hashToken(accessToken),
        tokenExpiresAt: now + ACCESS_TOKEN_TTL,
        refreshHash: hashToken(refreshToken),
        refreshExpiresAt: now + REFRESH_TOKEN_TTL,
      },
    };
  }

  private sweepOAuth(now = Date.now()): void {
    this.db.query('DELETE FROM oauth_codes WHERE expires_at <= $now').run({ now });
    this.db.query('DELETE FROM agent_tokens WHERE refresh_expires_at <= $now').run({ now });
    this.db
      .query(
        `DELETE FROM oauth_clients WHERE created_at <= $before
         AND id NOT IN (SELECT client_id FROM agent_tokens WHERE client_id IS NOT NULL) AND id NOT IN (SELECT client_id FROM oauth_codes)`,
      )
      .run({ before: now - UNUSED_CLIENT_TTL });
  }

  // --- sessions ----------------------------------------------------------

  createSession(userId: string, kind: SessionKind): string {
    const token = randomToken();
    const now = Date.now();
    this.db
      .query('INSERT INTO sessions (token_hash, user_id, kind, created_at, expires_at) VALUES ($hash, $userId, $kind, $now, $expires)')
      .run({ hash: hashToken(token), userId, kind, now, expires: now + SESSION_TTL });
    return token;
  }

  userForSession(token: string, kind: SessionKind): User | null {
    const row = this.db
      .query<UserRow, { hash: string; kind: SessionKind; now: number }>(
        `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = $hash AND sessions.kind = $kind AND sessions.expires_at > $now AND users.removed_at IS NULL`,
      )
      .get({ hash: hashToken(token), kind, now: Date.now() });
    return row ? toUser(row) : null;
  }

  deleteSession(token: string): void {
    this.db.query('DELETE FROM sessions WHERE token_hash = $hash').run({ hash: hashToken(token) });
  }

  deleteExpiredSessions(): void {
    this.db.query('DELETE FROM sessions WHERE expires_at <= $now').run({ now: Date.now() });
  }

  // --- projects ----------------------------------------------------------

  createProject(name: string, origins: string[], id: string = randomId()): Project {
    const project = { id, name, origins, createdAt: Date.now() };
    this.db
      .query('INSERT INTO projects (id, name, origins, created_at) VALUES ($id, $name, $origins, $createdAt)')
      .run({ ...project, origins: JSON.stringify(origins) });
    return project;
  }

  updateProject(id: string, name: string, origins: string[]): void {
    this.db.query('UPDATE projects SET name = $name, origins = $origins WHERE id = $id').run({ id, name, origins: JSON.stringify(origins) });
  }

  deleteProject(id: string): void {
    this.db.query('DELETE FROM projects WHERE id = $id').run({ id });
  }

  findProject(id: string): Project | null {
    const row = this.db
      .query<{ id: string; name: string; origins: string; created_at: number }, { id: string }>('SELECT * FROM projects WHERE id = $id')
      .get({ id });
    return row ? { id: row.id, name: row.name, origins: JSON.parse(row.origins), createdAt: row.created_at } : null;
  }

  listProjects(): Project[] {
    return this.db
      .query<{ id: string; name: string; origins: string; created_at: number }, []>('SELECT * FROM projects ORDER BY created_at')
      .all()
      .map((row) => ({ id: row.id, name: row.name, origins: JSON.parse(row.origins), createdAt: row.created_at }));
  }

  /** Whether any project lists this origin, exactly or through a wildcard. */
  originAllowed(origin: string): boolean {
    return this.listProjects().some((project) => allows(project.origins, origin));
  }

  // --- invites -----------------------------------------------------------

  createInvite(role: Invite['role'], createdBy: string, email: string | null = null): { invite: Invite; token: string } {
    const token = randomToken();
    const now = Date.now();
    const invite: Invite = { id: randomId(), role, createdBy, createdAt: now, expiresAt: now + INVITE_TTL, email };
    this.db
      .query(
        'INSERT INTO invites (id, token_hash, role, created_by, created_at, expires_at, email) VALUES ($id, $hash, $role, $createdBy, $createdAt, $expiresAt, $email)',
      )
      .run({ ...invite, hash: hashToken(token) });
    return { invite, token };
  }

  findUsableInvite(token: string): Invite | null {
    const row = this.db
      .query<InviteRow, { hash: string; now: number }>('SELECT * FROM invites WHERE token_hash = $hash AND used_at IS NULL AND expires_at > $now')
      .get({ hash: hashToken(token), now: Date.now() });
    return row ? toInvite(row) : null;
  }

  listPendingInvites(): Invite[] {
    return this.db
      .query<InviteRow, { now: number }>('SELECT * FROM invites WHERE used_at IS NULL AND expires_at > $now ORDER BY created_at')
      .all({ now: Date.now() })
      .map(toInvite);
  }

  revokeInvite(id: string): void {
    this.db.query('DELETE FROM invites WHERE id = $id AND used_at IS NULL').run({ id });
  }

  /** Marks the invite used and creates the account atomically, so one link can't create two users. */
  acceptInvite(token: string, input: { email: string; name: string; passwordHash: string }): User | null {
    return this.db.transaction(() => {
      const invite = this.findUsableInvite(token);
      if (!invite) return null;
      this.db.query('UPDATE invites SET used_at = $now WHERE id = $id').run({ id: invite.id, now: Date.now() });
      return this.createUser({ ...input, role: invite.role });
    })();
  }

  // --- threads -----------------------------------------------------------

  /**
   * What the overlay shows: every thread in the environment (and those from before environments, which
   * show everywhere), plus the threads on `page` made in other environments.
   */
  listThreads(projectId: string, scope: { environment?: string; page?: string }): Thread[] {
    const rows = this.db
      .query<ThreadRow, { projectId: string; environment: string | null; page: string | null }>(
        `${THREAD_SELECT} WHERE t.project_id = $projectId
           AND (($environment IS NOT NULL AND (t.environment = $environment OR t.environment IS NULL)) OR t.page = $page)
         ORDER BY t.created_at, t.rowid`,
      )
      .all({ projectId, environment: scope.environment ?? null, page: scope.page ?? null });
    return this.withComments(rows);
  }

  findThread(id: string): (Thread & { projectId: string }) | null {
    const row = this.db.query<ThreadRow, { id: string }>(`${THREAD_SELECT} WHERE t.id = $id`).get({ id });
    if (!row) return null;
    const [thread] = this.withComments([row]);
    return { ...thread!, projectId: row.project_id };
  }

  createThread(input: {
    projectId: string;
    page: string;
    search?: string | null;
    hash?: string | null;
    anchor: Anchor;
    authorId: string;
    body: string;
    environment?: string | null;
    revision?: string | null;
  }): string {
    const id = randomId();
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO threads (id, project_id, page, search, hash, environment, revision, anchor, status, status_at, author_id, created_at)
           VALUES ($id, $projectId, $page, $search, $hash, $environment, $revision, $anchor, 'open', $now, $authorId, $now)`,
        )
        .run({
          id,
          projectId: input.projectId,
          page: input.page,
          search: input.search ?? null,
          hash: input.hash ?? null,
          environment: input.environment ?? null,
          revision: input.revision ?? null,
          anchor: JSON.stringify(input.anchor),
          authorId: input.authorId,
          now,
        });
      this.insertComment(id, input.authorId, input.body, now);
      this.db.query("UPDATE counters SET value = value + 1 WHERE name = 'threads_created'").run();
    })();
    return id;
  }

  threadsCreated(): number {
    return this.db.query<{ value: number }, []>("SELECT value FROM counters WHERE name = 'threads_created'").get()!.value;
  }

  /** Returns whether the status changed. */
  setThreadStatus(id: string, status: ThreadStatus): boolean {
    return this.db.query('UPDATE threads SET status = $status, status_at = $now WHERE id = $id AND status != $status').run({ id, status, now: Date.now() }).changes > 0;
  }

  deleteThread(id: string): void {
    this.db.query('DELETE FROM threads WHERE id = $id').run({ id });
  }

  /** Returns the new comment's id. */
  addComment(threadId: string, authorId: string, body: string, agent: string | null = null): string {
    return this.insertComment(threadId, authorId, body, Date.now(), agent);
  }

  /** Threads across all projects, newest activity first: what an agent works through. */
  listThreadsForAgent(filter: {
    status: ThreadStatus | 'all';
    projectId?: string;
    page?: string;
    environment?: string;
    limit: number;
  }): Array<Thread & { projectId: string }> {
    const where: string[] = [];
    const params: Record<string, string | number> = { limit: filter.limit };
    if (filter.status !== 'all') {
      where.push('t.status = $status');
      params.status = filter.status;
    }
    if (filter.projectId) {
      where.push('t.project_id = $projectId');
      params.projectId = filter.projectId;
    }
    if (filter.page) {
      where.push('t.page = $page');
      params.page = filter.page;
    }
    if (filter.environment) {
      where.push('t.environment = $environment');
      params.environment = filter.environment;
    }
    const rows = this.db
      .query<ThreadRow, Record<string, string | number>>(
        `${THREAD_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY (SELECT MAX(created_at) FROM comments c WHERE c.thread_id = t.id) DESC, t.rowid DESC LIMIT $limit`,
      )
      .all(params);
    const projectOf = new Map(rows.map((row) => [row.id, row.project_id]));
    return this.withComments(rows).map((thread) => ({ ...thread, projectId: projectOf.get(thread.id)! }));
  }

  findComment(threadId: string, commentId: string): { authorId: string } | null {
    const row = this.db
      .query<{ author_id: string }, { threadId: string; commentId: string }>('SELECT author_id FROM comments WHERE id = $commentId AND thread_id = $threadId')
      .get({ threadId, commentId });
    return row ? { authorId: row.author_id } : null;
  }

  /** Deleting a thread's last comment deletes the thread. Returns whether the thread still exists. */
  deleteComment(threadId: string, commentId: string): boolean {
    return this.db.transaction(() => {
      this.db.query('DELETE FROM comments WHERE id = $commentId AND thread_id = $threadId').run({ threadId, commentId });
      const left = this.db.query<{ n: number }, { threadId: string }>('SELECT COUNT(*) AS n FROM comments WHERE thread_id = $threadId').get({ threadId })!;
      if (left.n === 0) this.deleteThread(threadId);
      return left.n > 0;
    })();
  }

  private insertComment(threadId: string, authorId: string, body: string, now: number, agent: string | null = null): string {
    const id = randomId();
    this.db
      .query('INSERT INTO comments (id, thread_id, author_id, agent, body, created_at) VALUES ($id, $threadId, $authorId, $agent, $body, $now)')
      .run({ id, threadId, authorId, agent, body, now });
    return id;
  }

  // --- notifications -----------------------------------------------------

  /** A user's preferences; users who never saved any get the defaults. */
  notificationSettings(userId: string): NotificationSettings {
    const row = this.db.query<{ level: NotifyLevel }, { userId: string }>('SELECT level FROM notification_settings WHERE user_id = $userId').get({ userId });
    const projects = this.db
      .query<{ project_id: string; level: NotifyLevel }, { userId: string }>('SELECT project_id, level FROM notification_project_levels WHERE user_id = $userId')
      .all({ userId });
    const channels = this.db
      .query<{ channel: string; enabled: number }, { userId: string }>('SELECT channel, enabled FROM notification_channels WHERE user_id = $userId')
      .all({ userId });
    return {
      level: row?.level ?? DEFAULT_NOTIFY_LEVEL,
      projects: Object.fromEntries(projects.map((p) => [p.project_id, p.level])),
      channels: Object.fromEntries(channels.map((c) => [c.channel, c.enabled === 1])),
    };
  }

  /** Replaces the user's levels: the default and per-project overrides (absent = same as the default). */
  saveNotificationLevels(userId: string, level: NotifyLevel, projects: Record<string, NotifyLevel>): void {
    this.db.transaction(() => {
      this.unsubscribeToken(userId);
      this.db.query('UPDATE notification_settings SET level = $level WHERE user_id = $userId').run({ userId, level });
      this.db.query('DELETE FROM notification_project_levels WHERE user_id = $userId').run({ userId });
      const insert = this.db.query(
        'INSERT INTO notification_project_levels (user_id, project_id, level) SELECT $userId, id, $level FROM projects WHERE id = $projectId',
      );
      for (const [projectId, projectLevel] of Object.entries(projects)) insert.run({ userId, projectId, level: projectLevel });
    })();
  }

  setNotificationChannel(userId: string, channel: string, enabled: boolean): void {
    this.db
      .query(
        `INSERT INTO notification_channels (user_id, channel, enabled) VALUES ($userId, $channel, $enabled)
         ON CONFLICT (user_id, channel) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run({ userId, channel, enabled: enabled ? 1 : 0 });
  }

  /** The user's unsubscribe token, created on first use. It can only switch notifications off, so it's stored as is. */
  unsubscribeToken(userId: string): string {
    this.db
      .query(
        `INSERT INTO notification_settings (user_id, level, unsubscribe_token) VALUES ($userId, $level, $token)
         ON CONFLICT (user_id) DO NOTHING`,
      )
      .run({ userId, level: DEFAULT_NOTIFY_LEVEL, token: randomToken() });
    return this.db.query<{ unsubscribe_token: string }, { userId: string }>('SELECT unsubscribe_token FROM notification_settings WHERE user_id = $userId').get({ userId })!
      .unsubscribe_token;
  }

  userForUnsubscribeToken(token: string): User | null {
    const row = this.db
      .query<UserRow, { token: string }>(
        'SELECT users.* FROM notification_settings s JOIN users ON users.id = s.user_id WHERE s.unsubscribe_token = $token AND users.removed_at IS NULL',
      )
      .get({ token });
    return row ? toUser(row) : null;
  }

  /** Every active user's level for one project and their channel switches, for deciding who hears about an event. */
  audience(projectId: string): Array<{ user: User; level: NotifyLevel; channels: Record<string, boolean> }> {
    const defaults = new Map(
      this.db.query<{ user_id: string; level: NotifyLevel }, []>('SELECT user_id, level FROM notification_settings').all().map((r) => [r.user_id, r.level]),
    );
    const overrides = new Map(
      this.db
        .query<{ user_id: string; level: NotifyLevel }, { projectId: string }>('SELECT user_id, level FROM notification_project_levels WHERE project_id = $projectId')
        .all({ projectId })
        .map((r) => [r.user_id, r.level]),
    );
    const channels = new Map<string, Record<string, boolean>>();
    for (const row of this.db.query<{ user_id: string; channel: string; enabled: number }, []>('SELECT * FROM notification_channels').all()) {
      channels.set(row.user_id, { ...channels.get(row.user_id), [row.channel]: row.enabled === 1 });
    }
    return this.listActiveUsers().map((user) => ({
      user,
      level: overrides.get(user.id) ?? defaults.get(user.id) ?? DEFAULT_NOTIFY_LEVEL,
      channels: channels.get(user.id) ?? {},
    }));
  }

  queueNotifications(rows: Array<Omit<PendingNotification, 'id' | 'attempts'>>): void {
    const insert = this.db.query(
      `INSERT INTO notifications (user_id, thread_id, comment_id, event, mention, actor_id, agent, created_at)
       VALUES ($userId, $threadId, $commentId, $event, $mention, $actorId, $agent, $createdAt)`,
    );
    this.db.transaction(() => {
      for (const row of rows) insert.run({ ...row, mention: row.mention ? 1 : 0 });
    })();
  }

  /** Someone who acts on a thread has seen it: what was waiting to tell them about it is dropped. */
  clearNotifications(userId: string, threadId: string): void {
    this.db.query('DELETE FROM notifications WHERE user_id = $userId AND thread_id = $threadId').run({ userId, threadId });
  }

  /**
   * Notifications whose thread has been quiet (for this recipient) since `quietBefore`, or that
   * have waited since `waitedBefore`, so a conversation that never pauses still gets delivered.
   */
  dueNotifications(quietBefore: number, waitedBefore: number): PendingNotification[] {
    return this.db
      .query<PendingRow, { quietBefore: number; waitedBefore: number }>(
        `WITH due AS (
           SELECT user_id, thread_id FROM notifications GROUP BY user_id, thread_id
           HAVING MAX(created_at) <= $quietBefore OR MIN(created_at) <= $waitedBefore
         )
         SELECT n.* FROM notifications n JOIN due ON due.user_id = n.user_id AND due.thread_id = n.thread_id
         ORDER BY n.user_id, n.created_at, n.id`,
      )
      .all({ quietBefore, waitedBefore })
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        threadId: row.thread_id,
        commentId: row.comment_id,
        event: row.event,
        mention: row.mention === 1,
        actorId: row.actor_id,
        agent: row.agent,
        attempts: row.attempts,
        createdAt: row.created_at,
      }));
  }

  deleteNotifications(ids: number[]): void {
    const remove = this.db.query('DELETE FROM notifications WHERE id = $id');
    this.db.transaction(() => ids.forEach((id) => remove.run({ id })))();
  }

  /** Counts a failed delivery; notifications that keep failing, or that are too old to matter, are dropped. */
  failNotifications(ids: number[], maxAttempts: number): void {
    const bump = this.db.query('UPDATE notifications SET attempts = attempts + 1 WHERE id = $id');
    this.db.transaction(() => {
      ids.forEach((id) => bump.run({ id }));
      this.db.query('DELETE FROM notifications WHERE attempts >= $maxAttempts').run({ maxAttempts });
    })();
  }

  deleteNotificationsBefore(time: number): void {
    this.db.query('DELETE FROM notifications WHERE created_at < $time').run({ time });
  }

  hasPendingNotifications(): boolean {
    return this.db.query('SELECT 1 FROM notifications LIMIT 1').get() !== null;
  }

  private withComments(rows: ThreadRow[]): Thread[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const commentRows = this.db
      .prepare<CommentRow, string[]>(
        `SELECT c.id, c.thread_id, c.agent, c.body, c.created_at, u.id AS author_id, u.name AS author_name
         FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.thread_id IN (${placeholders}) ORDER BY c.created_at, c.rowid`,
      )
      .all(...ids);
    const byThread = new Map<string, Comment[]>();
    for (const row of commentRows) {
      const list = byThread.get(row.thread_id) ?? [];
      list.push({
        id: row.id,
        body: row.body,
        createdAt: row.created_at,
        author: { id: row.author_id, name: row.author_name },
        ...(row.agent !== null && { agent: row.agent }),
      });
      byThread.set(row.thread_id, list);
    }
    return rows.map((row) => ({
      id: row.id,
      page: row.page,
      ...(row.search !== null && { search: row.search }),
      ...(row.hash !== null && { hash: row.hash }),
      ...(row.environment !== null && { environment: row.environment }),
      ...(row.revision !== null && { revision: row.revision }),
      anchor: JSON.parse(row.anchor) as Anchor,
      status: row.status,
      statusAt: row.status_at,
      createdAt: row.created_at,
      author: { id: row.author_id, name: row.author_name } satisfies Author,
      comments: byThread.get(row.id) ?? [],
    }));
  }
}

interface ThreadRow {
  id: string;
  project_id: string;
  page: string;
  search: string | null;
  hash: string | null;
  environment: string | null;
  revision: string | null;
  anchor: string;
  status: ThreadStatus;
  status_at: number;
  created_at: number;
  author_id: string;
  author_name: string;
}

interface CommentRow {
  id: string;
  thread_id: string;
  agent: string | null;
  body: string;
  created_at: number;
  author_id: string;
  author_name: string;
}

const THREAD_SELECT = `SELECT t.id, t.project_id, t.page, t.search, t.hash, t.environment, t.revision, t.anchor, t.status, t.status_at, t.created_at, u.id AS author_id, u.name AS author_name
  FROM threads t JOIN users u ON u.id = t.author_id`;
