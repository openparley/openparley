import { resolve } from 'node:path';
import type { PaidPlanId } from './plans';

export interface PolarConfig {
  apiUrl: string;
  accessToken: string;
  webhookSecret: string;
  /** Polar's customer portal, where customers manage their subscription (Polar handles sign-in). */
  portalUrl: string;
  /** Polar product id per plan. */
  products: Record<PaidPlanId, string>;
}

export type { MailConfig } from '@openparley/sync';
import type { MailConfig } from '@openparley/sync';

export interface CloudConfig {
  port: number;
  /** Workspaces live at <slug>.<domain>; the control plane at cloud.<domain>. */
  domain: string;
  scheme: 'http' | 'https';
  /** Port in public URLs, when it isn't the scheme's default (local development). */
  publicPort: number | null;
  /** Holds control.db and tenants/<slug>.db. */
  dataDir: string;
  overlayDir: string;
  /** Close a workspace's database after this long without requests. */
  idleMs: number;
  /** Upper bound on open workspaces; the least recently used is closed first. */
  maxOpen: number;
  trustProxy: boolean;
  /** Null until Polar is configured: sign-up then says it isn't open yet. */
  polar: PolarConfig | null;
  /** Null: emails are written to the log instead (development). */
  mail: MailConfig | null;
  supportEmail: string | null;
  /** Passed to every workspace: how long a thread must be quiet before its notifications go out. */
  notifyQuietMs: number;
}

const POLAR_ENV = ['POLAR_ACCESS_TOKEN', 'POLAR_WEBHOOK_SECRET', 'POLAR_PRODUCT_TEAM'] as const;

function loadPolar(env: Record<string, string | undefined>): PolarConfig | null {
  const present = POLAR_ENV.filter((name) => env[name]);
  if (present.length === 0) return null;
  if (present.length < POLAR_ENV.length) {
    throw new Error(`Polar is partly configured. Also set: ${POLAR_ENV.filter((name) => !env[name]).join(', ')}`);
  }
  const sandbox = env.POLAR_SERVER === 'sandbox';
  if (env.POLAR_SERVER && !sandbox && env.POLAR_SERVER !== 'production') throw new Error(`Invalid POLAR_SERVER: ${env.POLAR_SERVER}`);
  const portalUrl = env.POLAR_PORTAL_URL ?? (env.POLAR_ORG ? `https://${sandbox ? 'sandbox.' : ''}polar.sh/${env.POLAR_ORG}/portal` : null);
  if (!portalUrl) throw new Error('Set POLAR_ORG (your Polar organization slug) so customers can reach the billing portal.');
  return {
    apiUrl: (env.POLAR_API_URL ?? (sandbox ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh')).replace(/\/+$/, ''),
    accessToken: env.POLAR_ACCESS_TOKEN!,
    webhookSecret: env.POLAR_WEBHOOK_SECRET!,
    portalUrl,
    products: { team: env.POLAR_PRODUCT_TEAM! },
  };
}

export function loadCloudConfig(env: Record<string, string | undefined> = process.env): CloudConfig {
  const port = Number(env.PORT ?? 4000);
  const domain = (env.CLOUD_DOMAIN ?? 'localhost').toLowerCase();
  const local = domain === 'localhost' || domain.endsWith('.localhost');
  const scheme = (env.CLOUD_SCHEME ?? (local ? 'http' : 'https')) as CloudConfig['scheme'];
  if (scheme !== 'http' && scheme !== 'https') throw new Error(`Invalid CLOUD_SCHEME: ${scheme}`);
  if (!!env.RESEND_API_KEY !== !!env.MAIL_FROM) throw new Error('Set both RESEND_API_KEY and MAIL_FROM, or neither.');
  return {
    port,
    domain,
    scheme,
    publicPort: env.CLOUD_PUBLIC_PORT ? Number(env.CLOUD_PUBLIC_PORT) : local ? port : null,
    dataDir: env.DATA_DIR ?? resolve(import.meta.dir, '../data'),
    overlayDir: env.OVERLAY_DIR ?? resolve(import.meta.dir, '../../../packages/overlay/dist'),
    idleMs: Number(env.IDLE_MINUTES ?? 10) * 60_000,
    maxOpen: Number(env.MAX_OPEN_WORKSPACES ?? 500),
    trustProxy: env.TRUST_PROXY === '1',
    polar: loadPolar(env),
    mail: env.RESEND_API_KEY ? { resendApiKey: env.RESEND_API_KEY, from: env.MAIL_FROM! } : null,
    supportEmail: env.SUPPORT_EMAIL ?? null,
    notifyQuietMs: Number(env.NOTIFY_QUIET_SECONDS ?? 60) * 1000,
  };
}

export function urlFor(config: CloudConfig, host: string): string {
  return `${config.scheme}://${host}${config.publicPort ? `:${config.publicPort}` : ''}`;
}
