// Sets up Cloud email on Resend with DNS at Porkbun: a sending + receiving domain and a support inbox.
// Safe to rerun. Prints the plan unless --apply is given. Never overwrites existing DNS records.
//   bun --env-file=.env ee/cloud/scripts/setup-mail.ts [--apply] [--domain openparley.dev] [--inbox support]
// Porkbun: the domain needs "API access" switched on (Domain Management → domain → Details).
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    apply: { type: 'boolean', default: false },
    domain: { type: 'string', default: 'openparley.dev' },
    inbox: { type: 'string', default: 'support' },
    region: { type: 'string', default: 'eu-west-1' },
  },
});
const domain = values.domain!;
const apply = values.apply!;
const inboxAddress = `${values.inbox}@${domain}`;
const env = process.env;
env.PORKBUN_SECRET_API_KEY ??= env.PORKBUN_SECRET_KEY;
for (const name of ['RESEND_API_KEY', 'PORKBUN_API_KEY', 'PORKBUN_SECRET_API_KEY']) if (!env[name]) throw new Error(`Set ${name}.`);

async function resend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Resend ${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

async function porkbun<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://api.porkbun.com/api/json/v3${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apikey: env.PORKBUN_API_KEY, secretapikey: env.PORKBUN_SECRET_API_KEY, ...body }),
  });
  const json = (await res.json()) as T & { status: string; message?: string };
  if (json.status !== 'SUCCESS') throw new Error(`Porkbun ${path}: ${json.message ?? res.status}`);
  return json;
}

interface ResendRecord { record: string; name: string; type: string; value: string; priority?: number; status: string }
interface ResendDomain { id: string; name: string; status: string; capabilities: { sending: string; receiving: string }; records: ResendRecord[] }
interface DnsRecord { name: string; type: string; content: string; prio?: number }
interface PorkbunRecord { id: string; name: string; type: string; content: string; prio: string | null }

const unquote = (value: string) => value.replace(/^"(.*)"$/s, '$1');
/** Porkbun wants the part before the domain; Resend mixes relative names, full names and "@". */
const relative = (name: string) => (name === '@' || name === domain ? '' : name.replace(new RegExp(`\\.${domain.replace(/\./g, '\\.')}\\.?$`), ''));
const label = (name: string) => (name ? `${name}.${domain}` : domain);

// --- 1. Resend domain ---------------------------------------------------------
const { data: domains } = await resend<{ data: Array<{ id: string; name: string }> }>('GET', '/domains');
let found = domains.find((d) => d.name === domain);
if (!found) {
  console.log(`Resend: create domain ${domain} (${values.region}, sending + receiving)`);
  if (!apply) {
    console.log('\nDry run: Resend only shows the DNS records after the domain exists. Rerun with --apply.');
    process.exit(0);
  }
  found = await resend<{ id: string; name: string }>('POST', '/domains', {
    name: domain,
    region: values.region,
    capabilities: { sending: 'enabled', receiving: 'enabled' },
  });
}
let resendDomain = await resend<ResendDomain>('GET', `/domains/${found.id}`);
if (resendDomain.capabilities.receiving !== 'enabled' || resendDomain.capabilities.sending !== 'enabled') {
  console.log(`Resend: enable sending + receiving on ${domain}`);
  if (apply) resendDomain = await resend<ResendDomain>('PATCH', `/domains/${found.id}`, { capabilities: { sending: 'enabled', receiving: 'enabled' } }).then(() => resend<ResendDomain>('GET', `/domains/${found!.id}`));
}

// --- 2. DNS at Porkbun --------------------------------------------------------
const wanted: DnsRecord[] = resendDomain.records.map((r) => ({ name: relative(r.name), type: r.type, content: unquote(r.value), prio: r.priority }));
const existing = (await porkbun<{ records: PorkbunRecord[] }>(`/dns/retrieve/${domain}`)).records.map((r) => ({ ...r, name: relative(r.name) }));
// Gmail and Yahoo require DMARC for senders; p=none only asks for reports, it never blocks mail.
if (!existing.some((r) => r.name === '_dmarc' && r.type === 'TXT')) wanted.push({ name: '_dmarc', type: 'TXT', content: 'v=DMARC1; p=none;' });

const conflicts: string[] = [];
const toCreate: DnsRecord[] = [];
for (const record of wanted) {
  const same = existing.filter((r) => r.name === record.name && r.type === record.type);
  if (same.some((r) => unquote(r.content) === record.content)) {
    console.log(`DNS: ok      ${record.type.padEnd(5)} ${label(record.name)}`);
    continue;
  }
  const clash =
    (record.type === 'MX' && same.length > 0) ||
    (record.type === 'TXT' && record.content.startsWith('v=spf1') && same.some((r) => unquote(r.content).startsWith('v=spf1'))) ||
    existing.some((r) => r.name === record.name && r.type === 'CNAME');
  if (clash) conflicts.push(`${record.type} ${label(record.name)}: has ${same.map((r) => r.content).join(', ') || 'a CNAME'}, Resend wants ${record.content}`);
  else toCreate.push(record);
}
if (conflicts.length) {
  console.error(`\nNot touching DNS: these records already exist with other values. Decide what to keep, then rerun.\n  ${conflicts.join('\n  ')}`);
  process.exit(1);
}
for (const record of toCreate) {
  console.log(`DNS: create  ${record.type.padEnd(5)} ${label(record.name)}  ${record.content.length > 60 ? `${record.content.slice(0, 60)}…` : record.content}${record.prio !== undefined ? ` (prio ${record.prio})` : ''}`);
  await porkbun(`/dns/create/${domain}`, {
    name: record.name,
    type: record.type,
    content: record.content,
    ttl: 600,
    ...(record.prio !== undefined && { prio: record.prio }),
    notes: 'Resend (OpenParley Cloud email)',
    dryRun: !apply,
  });
}
if (!apply) {
  console.log(`\nDry run: Porkbun accepted every record above. Then: verify ${domain} in Resend and create the ${inboxAddress} inbox. Rerun with --apply.`);
  process.exit(0);
}

// --- 3. Verify ----------------------------------------------------------------
if (resendDomain.status !== 'verified') {
  await resend('POST', `/domains/${found.id}/verify`);
  process.stdout.write('Resend: verifying');
  for (let i = 0; i < 30 && resendDomain.status !== 'verified' && resendDomain.status !== 'failed'; i++) {
    await Bun.sleep(10_000);
    resendDomain = await resend<ResendDomain>('GET', `/domains/${found.id}`);
    process.stdout.write('.');
  }
  console.log(` ${resendDomain.status}`);
  for (const r of resendDomain.records) console.log(`  ${r.status.padEnd(12)} ${r.record.padEnd(10)} ${r.type.padEnd(5)} ${label(relative(r.name))}`);
}

// --- 4. Support inbox -----------------------------------------------------------
const { data: inboxes } = await resend<{ data: Array<{ id: string; email_address: string }> }>('GET', '/inboxes');
if (inboxes.some((i) => i.email_address === inboxAddress)) console.log(`Resend: inbox ${inboxAddress} exists`);
else {
  try {
    await resend('POST', '/inboxes', { email_address: inboxAddress, name: 'Support', from_name: 'OpenParley Support' });
    console.log(`Resend: created inbox ${inboxAddress}`);
  } catch (error) {
    console.error(`Resend: couldn't create the inbox yet (${(error as Error).message}). DNS may still be propagating; rerun with --apply in a few minutes.`);
    process.exitCode = 1;
  }
}
console.log(`\nFor Cloud: RESEND_API_KEY=<a sending-only key>  MAIL_FROM="OpenParley <hello@${domain}>"  SUPPORT_EMAIL=${inboxAddress}`);
