import { resolve } from 'node:path';
import type { GithubApp } from './github';
import type { MailConfig } from './mail';

export interface Config {
  port: number;
  databasePath: string;
  /** Public URL of this server, e.g. https://parley.example.com. Used for links and CSRF checks. */
  publicUrl: string;
  /** Directory holding the built overlay (`openparley.js` and `openparley-app-<hash>.js`). */
  overlayDir: string;
  /** Read the client IP from X-Forwarded-For (only behind a trusted reverse proxy). */
  trustProxy: boolean;
  /** Optional caps; null means unlimited. Generic on purpose: this server knows nothing about plans. */
  limits: Limits;
  /** Where an admin can raise the limits (e.g. a hosting provider's plan page); linked from the admin page. */
  limitsUrl: string | null;
  /** Shown where people create an account or sign in (e.g. a hosting provider's privacy policy). */
  privacyUrl: string | null;
  /** Resend, for invite emails. Null: invite links are shown to the admin to send themselves. */
  mail: MailConfig | null;
  /** Without `mail`: write emails (invites, notifications) to the log instead of not sending them. Development only. */
  mailLog?: boolean;
  /** Notifications about a thread go out once it has been quiet this long (batching a busy conversation). */
  notifyQuietMs: number;
  /**
   * A front door that signs people in for this server (OpenParley Cloud). It comes back to
   * `/auth/handoff` with an assertion signed with `key`. `startUrl`: its GitHub sign-in (the button,
   * labelled `label`); `accountUrl`: its own sign-in (e.g. an emailed link). `next` is appended to both.
   */
  trustedSignIn?: { key: string; startUrl: string | null; label: string; accountUrl?: string | null } | null;
  /** "Sign in with GitHub" through this server's own GitHub OAuth app (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`). */
  github?: GithubApp | null;
}

export interface Limits {
  members: number | null;
  projects: number | null;
  /** Threads ever created, so deleting old ones doesn't free room. Replies are never limited. */
  threads: number | null;
}

function limit(name: string, value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid ${name}: ${value}`);
  return n;
}

function seconds(name: string, value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${name}: ${value}`);
  return n;
}

function mailConfig(env: Record<string, string | undefined>): MailConfig | null {
  if (!!env.RESEND_API_KEY !== !!env.MAIL_FROM) throw new Error('Set both RESEND_API_KEY and MAIL_FROM, or neither.');
  return env.RESEND_API_KEY ? { resendApiKey: env.RESEND_API_KEY, from: env.MAIL_FROM! } : null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid PORT: ${env.PORT}`);
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  new URL(publicUrl);
  return {
    port,
    databasePath: env.DATABASE_PATH ?? resolve(import.meta.dir, '../data/openparley.db'),
    publicUrl,
    overlayDir: env.OVERLAY_DIR ?? resolve(import.meta.dir, '../../../packages/overlay/dist'),
    trustProxy: env.TRUST_PROXY === '1',
    limits: {
      members: limit('MAX_MEMBERS', env.MAX_MEMBERS),
      projects: limit('MAX_PROJECTS', env.MAX_PROJECTS),
      threads: limit('MAX_THREADS', env.MAX_THREADS),
    },
    limitsUrl: env.LIMITS_URL ? new URL(env.LIMITS_URL).href : null,
    privacyUrl: env.PRIVACY_URL ? new URL(env.PRIVACY_URL).href : null,
    mail: mailConfig(env),
    mailLog: env.MAIL_LOG === '1',
    notifyQuietMs: seconds('NOTIFY_QUIET_SECONDS', env.NOTIFY_QUIET_SECONDS, 60) * 1000,
    github: githubConfig(env),
  };
}

/** GitHub sign-in from `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` (and `GITHUB_WEB_URL`/`GITHUB_API_URL` for a fake one). */
export function githubConfig(env: Record<string, string | undefined>): GithubApp | null {
  if (!!env.GITHUB_CLIENT_ID !== !!env.GITHUB_CLIENT_SECRET) throw new Error('Set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or neither.');
  if (!env.GITHUB_CLIENT_ID) return null;
  return {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET!,
    ...(env.GITHUB_WEB_URL && { webUrl: new URL(env.GITHUB_WEB_URL).origin }),
    ...(env.GITHUB_API_URL && { apiUrl: new URL(env.GITHUB_API_URL).origin }),
  };
}
