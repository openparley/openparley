import { resolve } from 'node:path';
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
  /** Resend, for invite emails. Null: invite links are shown to the admin to send themselves. */
  mail: MailConfig | null;
  /** Without `mail`: write emails (invites, notifications) to the log instead of not sending them. Development only. */
  mailLog?: boolean;
  /** Notifications about a thread go out once it has been quiet this long (batching a busy conversation). */
  notifyQuietMs: number;
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
    mail: mailConfig(env),
    mailLog: env.MAIL_LOG === '1',
    notifyQuietMs: seconds('NOTIFY_QUIET_SECONDS', env.NOTIFY_QUIET_SECONDS, 60) * 1000,
  };
}
