import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Append-only: never edit a migration that has shipped. `PRAGMA user_version` tracks progress.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    created_at INTEGER NOT NULL,
    removed_at INTEGER
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('web', 'api')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    origins TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page TEXT NOT NULL,
    anchor TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    status_at INTEGER NOT NULL,
    author_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX threads_page ON threads(project_id, page);
  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX comments_thread ON comments(thread_id, created_at);
  `,
  `
  CREATE TABLE counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  INSERT INTO counters (name, value) SELECT 'threads_created', COUNT(*) FROM threads;
  `,
  `
  CREATE TABLE agent_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX agent_tokens_user ON agent_tokens(user_id);
  ALTER TABLE comments ADD COLUMN agent TEXT;
  `,
  `
  ALTER TABLE threads ADD COLUMN environment TEXT;
  ALTER TABLE threads ADD COLUMN revision TEXT;
  `,
  `
  CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    secret_hash TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  ALTER TABLE agent_tokens ADD COLUMN client_id TEXT REFERENCES oauth_clients(id) ON DELETE CASCADE;
  ALTER TABLE agent_tokens ADD COLUMN token_expires_at INTEGER;
  ALTER TABLE agent_tokens ADD COLUMN refresh_hash TEXT;
  ALTER TABLE agent_tokens ADD COLUMN refresh_expires_at INTEGER;
  CREATE UNIQUE INDEX agent_tokens_refresh ON agent_tokens(refresh_hash);
  `,
  `
  ALTER TABLE invites ADD COLUMN email TEXT;
  `,
  `
  CREATE TABLE notification_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    level TEXT NOT NULL CHECK (level IN ('off', 'mentions', 'participating', 'everything')),
    unsubscribe_token TEXT NOT NULL UNIQUE
  );
  CREATE TABLE notification_project_levels (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    level TEXT NOT NULL CHECK (level IN ('off', 'mentions', 'participating', 'everything')),
    PRIMARY KEY (user_id, project_id)
  );
  CREATE TABLE notification_channels (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel)
  );
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
    event TEXT NOT NULL CHECK (event IN ('comment', 'resolved', 'reopened')),
    mention INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT NOT NULL REFERENCES users(id),
    agent TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX notifications_user_thread ON notifications(user_id, thread_id, created_at);
  `,
  `
  ALTER TABLE users ADD COLUMN handle TEXT;
  CREATE UNIQUE INDEX users_handle ON users(handle);
  `,
  `
  ALTER TABLE threads ADD COLUMN search TEXT;
  ALTER TABLE threads ADD COLUMN hash TEXT;
  CREATE INDEX threads_environment ON threads(project_id, environment);
  `,
  `
  ALTER TABLE agent_tokens ADD COLUMN previous_refresh_hash TEXT;
  ALTER TABLE agent_tokens ADD COLUMN previous_refresh_until INTEGER;
  ALTER TABLE agent_tokens ADD COLUMN previous_response TEXT;
  CREATE INDEX agent_tokens_previous_refresh ON agent_tokens(previous_refresh_hash);
  `,
];

export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true, create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const { user_version: current } = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this server (v${MIGRATIONS.length}). Upgrade the server.`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}
