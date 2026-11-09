import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thread } from '@openparley/protocol';
import { Cloud } from '../src/cloud';
import { loadCloudConfig, type CloudConfig } from '../src/config';
import { ControlStore } from '../src/control';

const DOMAIN = 'parley.test';
const SITE = 'https://shop.example';
const anchor = { v: 1, selector: '#buy', path: 'body > button:nth-of-type(1)', tag: 'button', text: 'Buy', attrs: {}, point: [0.5, 0.5] };
const clouds: Cloud[] = [];

function makeCloud(overrides: Partial<CloudConfig> = {}) {
  const config: CloudConfig = {
    ...loadCloudConfig({ CLOUD_DOMAIN: DOMAIN, DATA_DIR: mkdtempSync(join(tmpdir(), 'openparley-cloud-')) }),
    overlayDir: '/nonexistent',
    ...overrides,
  };
  const cloud = new Cloud(config);
  clouds.push(cloud);
  return { cloud, config };
}

afterEach(() => {
  for (const cloud of clouds.splice(0)) cloud.close();
});

/** A browser on one workspace host: keeps its cookie, sends same-origin form posts. */
function browser(cloud: Cloud, slug: string) {
  const origin = `https://${slug}.${DOMAIN}`;
  let cookie = '';
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    if (init.method === 'POST' && !headers.has('origin')) headers.set('origin', origin);
    const res = await cloud.fetch(new Request(`${origin}${path}`, { ...init, headers, redirect: 'manual' }));
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return res;
  };
  const post = (path: string, fields: Record<string, string>) =>
    request(path, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { origin, request, post };
}

/** Provisions a workspace, creates its owner through the setup link, a project, and an API token. */
async function workspace(cloud: Cloud, slug: string, limits: { maxMembers?: number; maxProjects?: number; maxThreads?: number } = {}) {
  const { setupUrl } = cloud.provision({ slug, name: slug.toUpperCase(), ...limits });
  const b = browser(cloud, slug);
  const setup = new URL(setupUrl);
  expect(setup.host).toBe(`${slug}.${DOMAIN}`);
  const res = await b.post('/setup', { token: setup.searchParams.get('token')!, name: `${slug} owner`, email: 'owner@example.com', password: 'correct horse battery' });
  expect(res.status).toBe(302);
  await b.post('/admin/projects', { name: 'Shop', origins: SITE });
  const project = /data-project=(?:&quot;|")([\w-]+)/.exec(await (await b.request('/admin')).text())![1]!;
  const connect = await (await b.request(`/connect?project=${project}&origin=${encodeURIComponent(SITE)}`)).text();
  const token = /"token":"([^"]+)"/.exec(connect)![1]!;
  const api = (method: string, path: string, body?: unknown, host = slug) =>
    cloud.fetch(
      new Request(`https://${host}.${DOMAIN}/api${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, origin: SITE, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  return { b, project, token, api };
}

describe('routing', () => {
  test('control plane, workspaces and unknown hosts', async () => {
    const { cloud } = makeCloud();
    cloud.provision({ slug: 'acme', name: 'Acme' });
    const health = await cloud.fetch(new Request(`https://cloud.${DOMAIN}/health`));
    expect(await health.json()).toEqual({ ok: true, workspaces: 1, open: 1 });
    expect((await cloud.fetch(new Request(`https://acme.${DOMAIN}/health`))).status).toBe(200);
    for (const url of [`https://nope.${DOMAIN}/`, `https://acme.other.test/`, `https://a.b.${DOMAIN}/`, 'https://evil.test/']) {
      const res = await cloud.fetch(new Request(url));
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('<script');
    }
  });

  test('uses the Host header and ignores port and case', async () => {
    const { cloud } = makeCloud();
    cloud.provision({ slug: 'acme', name: 'Acme' });
    const res = await cloud.fetch(new Request('http://127.0.0.1:4000/health', { headers: { host: `ACME.${DOMAIN}:4000` } }));
    expect(res.status).toBe(200);
  });

  test('workspace names are validated', () => {
    const { cloud } = makeCloud();
    for (const slug of ['', '-acme', 'acme-', 'Acme', 'a.b', 'cloud', 'www', 'x'.repeat(33)]) {
      expect(() => cloud.provision({ slug, name: 'X' })).toThrow();
    }
    cloud.provision({ slug: 'acme', name: 'Acme' });
    expect(() => cloud.provision({ slug: 'acme', name: 'Again' })).toThrow('already exists');
  });
});

describe('isolation', () => {
  test('each workspace has its own database file, users, projects and threads', async () => {
    const { cloud, config } = makeCloud();
    const acme = await workspace(cloud, 'acme');
    const globex = await workspace(cloud, 'globex');
    expect(existsSync(join(config.dataDir, 'tenants/acme.db'))).toBe(true);
    expect(existsSync(join(config.dataDir, 'tenants/globex.db'))).toBe(true);

    const created = await acme.api('POST', '/threads', { project: acme.project, page: '/', anchor, body: 'Acme only' });
    expect(created.status).toBe(201);
    const { thread } = (await created.json()) as { thread: Thread };

    // Globex can't see Acme's project or thread, even when it knows the ids.
    expect((await globex.api('GET', `/threads?project=${acme.project}&page=/`)).status).toBe(404);
    expect((await globex.api('GET', `/threads/${thread.id}`)).status).toBe(404);
    // An Acme token means nothing on Globex's host, and vice versa.
    expect((await acme.api('GET', '/me', undefined, 'globex')).status).toBe(401);
    expect((await globex.api('GET', '/me', undefined, 'acme')).status).toBe(401);
    // Acme's session cookie isn't valid on Globex.
    const res = await cloud.fetch(new Request(`https://globex.${DOMAIN}/admin`, { headers: { cookie: 'openparley_session=x' } }));
    expect(res.status).toBe(302);
  });

  test('a setup link only works on its own workspace', async () => {
    const { cloud } = makeCloud();
    const { setupUrl } = cloud.provision({ slug: 'acme', name: 'Acme' });
    cloud.provision({ slug: 'globex', name: 'Globex' });
    const token = new URL(setupUrl).searchParams.get('token')!;
    const res = await browser(cloud, 'globex').post('/setup', { token, name: 'Mallory', email: 'm@example.com', password: 'correct horse battery' });
    expect(res.status).toBe(403);
  });
});

describe('lifecycle', () => {
  test('suspending blocks the workspace immediately and keeps its data', async () => {
    const { cloud, config } = makeCloud();
    const acme = await workspace(cloud, 'acme');
    await acme.api('POST', '/threads', { project: acme.project, page: '/', anchor, body: 'Kept' });

    // Changed by another process (the CLI) through its own handle on control.db.
    const operator = new ControlStore(config.dataDir);
    operator.update('acme', { status: 'suspended' });
    const blocked = await acme.api('GET', `/threads?project=${acme.project}&page=/`);
    expect(blocked.status).toBe(402);
    expect(cloud.stats().open).toBe(0);

    operator.update('acme', { status: 'active' });
    operator.close();
    const back = (await (await acme.api('GET', `/threads?project=${acme.project}&page=/`)).json()) as { threads: Thread[] };
    expect(back.threads.map((t) => t.comments[0]!.body)).toEqual(['Kept']);
  });

  test('idle workspaces are closed and reopen transparently', async () => {
    const { cloud } = makeCloud({ idleMs: 60_000 });
    const acme = await workspace(cloud, 'acme');
    expect(cloud.stats().open).toBe(1);
    cloud.closeIdle(Date.now() + 61_000);
    expect(cloud.stats().open).toBe(0);
    expect((await acme.api('GET', '/me')).status).toBe(200);
    expect(cloud.stats().open).toBe(1);
  });

  test('an idle workspace with notifications still waiting stays open until they are sent', async () => {
    const { cloud } = makeCloud({ idleMs: 60_000 });
    const acme = await workspace(cloud, 'acme');
    const invite = /\/invite\/([\w-]+)/.exec(await (await acme.b.post('/admin/invites', { role: 'member' })).text())![1]!;
    const mia = browser(cloud, 'acme');
    await mia.post(`/invite/${invite}`, { name: 'Mia', email: 'mia@example.com', password: 'another long password' });
    const connect = await (await mia.request(`/connect?project=${acme.project}&origin=${encodeURIComponent(SITE)}`)).text();
    const token = /"token":"([^"]+)"/.exec(connect)![1]!;
    const { thread } = (await (await acme.api('POST', '/threads', { project: acme.project, page: '/', anchor, body: 'Hi' })).json()) as { thread: Thread };
    await cloud.fetch(
      new Request(`https://acme.${DOMAIN}/api/threads/${thread.id}/comments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: SITE },
        body: JSON.stringify({ body: '@acme owner hello' }),
      }),
    );
    cloud.closeIdle(Date.now() + 61_000);
    expect(cloud.stats().open).toBe(1);
  });

  test('never keeps more than maxOpen workspaces open (least recently used goes first)', async () => {
    const { cloud } = makeCloud({ maxOpen: 2 });
    for (const slug of ['a1', 'a2', 'a3']) cloud.provision({ slug, name: slug });
    expect(cloud.stats().open).toBe(2);
    await cloud.fetch(new Request(`https://a1.${DOMAIN}/health`));
    expect(cloud.stats().open).toBe(2);
  });

  test('sign-ups that never became a workspace are deleted 30 days after they expire', () => {
    const { config } = makeCloud();
    const control = new ControlStore(config.dataDir);
    const day = 24 * 60 * 60 * 1000;
    const signup = (slug: string, expiresAt: number) =>
      control.createSignup({ slug, name: slug, email: `${slug}@example.com`, plan: 'free', browserHash: 'x', expiresAt });
    const old = signup('old', Date.now() - 31 * day);
    const recent = signup('recent', Date.now() - 29 * day);
    signup('next', Date.now() + day);
    expect(control.findSignup(old.id)).toBeNull();
    expect(control.findSignup(recent.id)).not.toBeNull();
    control.close();
  });

  test('limits come from the control plane and apply live', async () => {
    const { cloud } = makeCloud();
    const acme = await workspace(cloud, 'acme', { maxProjects: 1 });
    const second = await acme.b.post('/admin/projects', { name: 'Second', origins: SITE });
    expect(second.status).toBe(400);
    cloud.control.update('acme', { maxProjects: 2 });
    expect((await acme.b.post('/admin/projects', { name: 'Second', origins: SITE })).status).toBe(302);
  });

  test('the thread limit applies live and lifting it takes effect immediately', async () => {
    const { cloud } = makeCloud();
    const acme = await workspace(cloud, 'acme', { maxThreads: 1 });
    const create = () => acme.api('POST', '/threads', { project: acme.project, page: '/', anchor, body: 'x' });
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(403);
    cloud.control.update('acme', { maxThreads: null });
    expect((await create()).status).toBe(201);
  });
});
