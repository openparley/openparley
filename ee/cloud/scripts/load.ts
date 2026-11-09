// Measures what Cloud costs per workspace. Runs in-process against a throwaway data directory.
//   bun ee/cloud/scripts/load.ts [workspaces=500] [active=50] [requests=20000]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cloud } from '../src/cloud';
import { loadCloudConfig } from '../src/config';

const [total = 500, active = 50, requests = 20_000] = Bun.argv.slice(2).map(Number);
const DOMAIN = 'parley.test';
const SITE = 'https://shop.example';
const anchor = { v: 1, selector: 'p', path: 'body > p:nth-of-type(1)', tag: 'p', text: 'Hi', attrs: {}, point: [0.5, 0.5] };
const dataDir = mkdtempSync(join(tmpdir(), 'openparley-load-'));
const cloud = new Cloud({ ...loadCloudConfig({ CLOUD_DOMAIN: DOMAIN, DATA_DIR: dataDir, MAX_OPEN_WORKSPACES: String(total + 1) }) });
const mb = () => {
  Bun.gc(true);
  return process.memoryUsage().rss / 1024 / 1024;
};

const baseline = mb();
for (let i = 0; i < total; i++) cloud.provision({ slug: `w${i}`, name: `W${i}` });
cloud.closeIdle(Date.now() + 24 * 3600_000);
const afterProvision = mb();

// Make `active` workspaces real: owner, project, API token, ten threads each.
const tokens: { slug: string; token: string; project: string }[] = [];
for (let i = 0; i < active; i++) {
  const slug = `w${i}`;
  const origin = `https://${slug}.${DOMAIN}`;
  let cookie = '';
  const go = async (path: string, form?: Record<string, string>) => {
    const res = await cloud.fetch(
      new Request(`${origin}${path}`, {
        method: form ? 'POST' : 'GET',
        redirect: 'manual',
        headers: { origin, cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
      }),
    );
    cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return res.text();
  };
  const setupToken = cloud.control.find(slug)!.setupToken;
  await go('/setup', { token: setupToken, name: 'Owner', email: 'o@example.com', password: 'correct horse battery' });
  await go('/admin/projects', { name: 'Site', origins: SITE });
  const project = /data-project=(?:&quot;|")([\w-]+)/.exec(await go('/admin'))![1]!;
  const token = /"token":"([^"]+)"/.exec(await go(`/connect?project=${project}&origin=${encodeURIComponent(SITE)}`))![1]!;
  tokens.push({ slug, token, project });
  for (let t = 0; t < 10; t++) {
    await cloud.fetch(
      new Request(`${origin}/api/threads`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: SITE },
        body: JSON.stringify({ project, page: '/', anchor, body: `Comment ${t}` }),
      }),
    );
  }
}
const openActive = cloud.stats().open;
const afterActive = mb();

const started = performance.now();
for (let r = 0; r < requests; r++) {
  const { slug, token, project } = tokens[r % tokens.length]!;
  const res = await cloud.fetch(
    new Request(`https://${slug}.${DOMAIN}/api/threads?project=${project}&page=/`, { headers: { authorization: `Bearer ${token}`, origin: SITE } }),
  );
  if (res.status !== 200) throw new Error(`Unexpected ${res.status}`);
  await res.arrayBuffer();
}
const seconds = (performance.now() - started) / 1000;

console.log(`workspaces provisioned        ${total}`);
console.log(`RSS baseline                  ${baseline.toFixed(0)} MB`);
console.log(`RSS after provisioning (idle) ${afterProvision.toFixed(0)} MB  (+${(afterProvision - baseline).toFixed(1)} MB for ${total} idle)`);
console.log(`RSS with ${openActive} open + data      ${afterActive.toFixed(0)} MB  (~${((afterActive - afterProvision) / openActive).toFixed(2)} MB per open workspace)`);
console.log(`thread lists, round-robin     ${requests} in ${seconds.toFixed(1)} s = ${(requests / seconds).toFixed(0)} req/s on one core`);
cloud.close();
