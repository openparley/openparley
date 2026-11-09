// Operator tool. Safe to run next to the server: changes in
// control.db apply on the server's next request for that workspace.
//   bun ee/cloud/src/cli.ts create acme "Acme Inc" [--members 10] [--projects 3] [--threads 100]
//   bun ee/cloud/src/cli.ts list
//   bun ee/cloud/src/cli.ts suspend acme | resume acme
//   bun ee/cloud/src/cli.ts limits acme --members 25 [--projects none] [--threads none]
//   bun ee/cloud/src/cli.ts setup-link acme     (when the owner lost theirs; useless once they've set up)
//   bun ee/cloud/src/cli.ts upgrade-link acme   (a free workspace's 24-hour upgrade link; send it only to the billing contact)
//   bun ee/cloud/src/cli.ts signup-link acme    (a free sign-up's confirmation link; send it only to the address that signed up)
import { parseArgs } from 'node:util';
import { REQUESTED_RENEWAL_MS } from './billing';
import { Cloud } from './cloud';
import { loadCloudConfig } from './config';

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { members: { type: 'string' }, projects: { type: 'string' }, threads: { type: 'string' } },
});
const [command, slug, name] = positionals;

const limit = (value: string | undefined): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === 'none') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid limit: ${value}`);
  return n;
};

const cloud = new Cloud(loadCloudConfig());
try {
  switch (command) {
    case 'create': {
      if (!slug || !name) throw new Error('Usage: create <slug> "<name>" [--members N] [--projects N] [--threads N]');
      const { setupUrl } = cloud.provision({ slug, name, maxMembers: limit(values.members), maxProjects: limit(values.projects), maxThreads: limit(values.threads) });
      console.log(`Created ${slug}. Send the owner this one-time setup link:\n  ${setupUrl}`);
      break;
    }
    case 'list':
      for (const t of cloud.control.list()) {
        const billing = t.plan ? `${t.plan} ${t.billingEmail}` : 'no billing';
        const since = t.suspendedAt ? ` since ${new Date(t.suspendedAt).toISOString().slice(0, 10)}` : '';
        console.log(`${t.slug.padEnd(24)} ${(t.status + since).padEnd(22)} members ${t.maxMembers ?? '∞'}  projects ${t.maxProjects ?? '∞'}  threads ${t.maxThreads ?? '∞'}  ${billing}  ${t.name}`);
      }
      break;
    case 'suspend':
    case 'resume':
      if (!slug) throw new Error(`Usage: ${command} <slug>`);
      cloud.control.update(slug, { status: command === 'suspend' ? 'suspended' : 'active' });
      console.log(`${slug}: ${command === 'suspend' ? 'suspended' : 'active'}`);
      break;
    case 'limits':
      if (!slug) throw new Error('Usage: limits <slug> [--members N|none] [--projects N|none] [--threads N|none]');
      cloud.control.update(slug, { maxMembers: limit(values.members), maxProjects: limit(values.projects), maxThreads: limit(values.threads) });
      console.log(`${slug}: limits updated`);
      break;
    case 'setup-link': {
      const tenant = slug ? cloud.control.find(slug) : null;
      if (!tenant) throw new Error('Usage: setup-link <slug>');
      console.log(cloud.hasOwner(tenant.slug) ? `${slug} already has an owner; they can sign in.` : cloud.setupUrl(tenant));
      break;
    }
    case 'upgrade-link': {
      const tenant = slug ? cloud.control.find(slug) : null;
      if (!tenant) throw new Error('Usage: upgrade-link <slug>');
      if (tenant.plan !== 'free' || tenant.status !== 'active') throw new Error(`${slug} is ${tenant.status === 'active' ? `on ${tenant.plan ?? 'no'} plan` : 'paused'}; only active free workspaces can be upgraded.`);
      console.log(`Billing contact: ${tenant.billingEmail ?? 'none'}`);
      console.log(cloud.renewalUrl(tenant.slug, REQUESTED_RENEWAL_MS));
      break;
    }
    case 'signup-link': {
      const signup = slug ? cloud.control.pendingFreeSignup(slug) : null;
      if (!signup) throw new Error('Usage: signup-link <slug> (needs an unconfirmed free sign-up from the last 24 hours)');
      console.log(`Signed up as: ${signup.email}`);
      console.log(cloud.confirmUrl(signup.id));
      break;
    }
    default:
      throw new Error('Commands: create, list, suspend, resume, limits, setup-link, upgrade-link, signup-link');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  cloud.close();
}
