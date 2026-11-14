import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mail } from '@openparley/sync';
import { startFakeGithub } from '../../../apps/sync/dev/fake-github';
import { Cloud } from '../src/cloud';
import { loadCloudConfig } from '../src/config';

const DOMAIN = 'parley.test';
const CONTROL = `https://cloud.${DOMAIN}`;
const github = startFakeGithub();
afterAll(() => github.stop(true));
const clouds: Cloud[] = [];
afterEach(() => {
  for (const cloud of clouds.splice(0)) cloud.close();
});

function makeCloud(options: { github?: boolean } = {}) {
  const mails: Mail[] = [];
  const config = {
    ...loadCloudConfig({ CLOUD_DOMAIN: DOMAIN, DATA_DIR: mkdtempSync(join(tmpdir(), 'openparley-accounts-')) }),
    overlayDir: '/nonexistent',
    github: options.github === false ? null : { clientId: 'cloud', clientSecret: 'secret', webUrl: github.url.origin, apiUrl: github.url.origin },
  };
  const cloud = new Cloud(config, { mailer: { send: async (mail) => void mails.push(mail) } });
  clouds.push(cloud);
  return { cloud, mails };
}

/**
 * A browser across Cloud's hosts (cookies per host) that follows redirects, also through the fake
 * GitHub, which approves as `githubLogin`.
 */
function browser(cloud: Cloud, githubLogin = 'olivia-dev') {
  const jars = new Map<string, Map<string, string>>();
  const send = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(url);
    if (target.origin === github.url.origin) {
      if (target.pathname === '/login/oauth/authorize') target.searchParams.set('login', githubLogin);
      return fetch(target, { redirect: 'manual' });
    }
    const jar = jars.get(target.host) ?? new Map<string, string>();
    jars.set(target.host, jar);
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    if (init.method === 'POST' && !headers.has('origin')) headers.set('origin', target.origin);
    const res = await cloud.fetch(new Request(target, { ...init, headers, redirect: 'manual' }));
    for (const set of res.headers.getSetCookie()) {
      const [name, value = ''] = set.split(';')[0]!.split('=');
      if (set.includes('Max-Age=0') || !value) jar.delete(name!);
      else jar.set(name!, value);
    }
    return res;
  };
  /** Follows redirects; returns the last response and its URL. */
  const go = async (url: string, init: RequestInit = {}) => {
    let res = await send(url, init);
    let at = url;
    for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 10; hops++) {
      at = new URL(res.headers.get('location')!, at).href;
      res = await send(at);
    }
    return { res, url: at, html: await res.text() };
  };
  const post = (url: string, fields: Record<string, string>) =>
    go(url, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return { go, post };
}

/** A workspace whose owner set up with `email`; returns the owner's browser on it. */
async function workspace(cloud: Cloud, slug: string, email = 'olivia@acme.test') {
  const { tenant, setupUrl } = cloud.provision({ slug, name: slug[0]!.toUpperCase() + slug.slice(1) });
  const owner = browser(cloud);
  const setup = new URL(setupUrl);
  await owner.post(`${setup.origin}/setup`, { token: setup.searchParams.get('token')!, name: 'Olivia', email, password: 'correct horse battery' });
  return { tenant, owner, url: setup.origin };
}

async function confirmEmail(owner: ReturnType<typeof browser>, url: string, mails: Mail[]) {
  await owner.post(`${url}/admin/email-confirmation`, {});
  const link = /(https:\/\/\S+\/confirm-email\/\S+)/.exec(mails.at(-1)!.text)![1]!;
  await owner.post(link, {});
}

describe('Cloud accounts', () => {
  test('GitHub sign-in lists the workspaces where your email is confirmed, and Open signs you in there', async () => {
    const { cloud, mails } = makeCloud();
    const { url, owner } = await workspace(cloud, 'acme');
    const me = browser(cloud);

    const home = await me.go(`${CONTROL}/auth/github`);
    expect(home.url).toBe(`${CONTROL}/`);
    // The address was typed at setup and never confirmed: not listed yet.
    expect(home.html).toContain('No workspaces for olivia@acme.test');

    await confirmEmail(owner, url, mails);
    const list = await me.go(`${CONTROL}/`);
    expect(list.html).toContain('Acme');
    const tenant = cloud.control.find('acme')!;
    const opened = await me.go(`${CONTROL}/open/${tenant.id}`);
    expect(opened.url).toBe(`${url}/admin`);
    expect(opened.html).toContain('Olivia · owner');
    // Matched by email, so GitHub is linked in the workspace too.
    expect(cloud.accounts.memberships(cloud.accounts.findByEmail('olivia@acme.test')!)).toHaveLength(1);
  });

  test('a workspace you are not in is not opened for you', async () => {
    const { cloud } = makeCloud();
    const { tenant } = await workspace(cloud, 'acme', 'someone@else.test');
    const me = browser(cloud);
    await me.go(`${CONTROL}/auth/github`);
    const res = await me.go(`${CONTROL}/open/${tenant.id}`);
    expect(res.res.status).toBe(404);
  });

  test('a teammate joins with GitHub from the invite page; the invited address stays', async () => {
    const { cloud } = makeCloud();
    const { url, owner } = await workspace(cloud, 'acme');
    const invited = await owner.post(`${url}/admin/invites`, { role: 'member', email: 'mia@acme.test' });
    const inviteUrl = /(https:\/\/acme\.parley\.test\/invite\/[\w-]+)/.exec(invited.html)![1]!;

    const mia = browser(cloud, 'mia-dev');
    const page = await mia.go(inviteUrl);
    const join = /href="(https:\/\/cloud\.parley\.test\/auth\/github\?[^"]+)"/.exec(page.html)![1]!.replaceAll('&amp;', '&');
    const joined = await mia.go(join);
    expect(joined.url).toBe(`${url}/admin?welcome=1`);
    expect(joined.html).toContain('Welcome, Mia.');
    // Mia's GitHub account is linked there, so Cloud lists the workspace for her.
    expect((await mia.go(`${CONTROL}/`)).html).toContain('acme.parley.test · member');
  });

  test('"Continue with GitHub" on a workspace without a matching account says so', async () => {
    const { cloud } = makeCloud();
    const { url } = await workspace(cloud, 'acme', 'someone@else.test');
    const stranger = browser(cloud);
    const login = await stranger.go(`${url}/login`);
    const start = /href="(https:\/\/cloud\.parley\.test\/auth\/github\?[^"]+)"/.exec(login.html)![1]!.replaceAll('&amp;', '&');
    const res = await stranger.go(start);
    expect(res.res.status).toBe(403);
    expect(res.html).toContain('no account for GitHub account olivia-dev');
  });

  test('an emailed link signs in; opening it alone does nothing', async () => {
    const { cloud, mails } = makeCloud({ github: false });
    const { url, owner } = await workspace(cloud, 'acme');
    await confirmEmail(owner, url, mails);
    const me = browser(cloud);
    expect((await me.go(`${CONTROL}/login`)).html).not.toContain('Continue with GitHub');
    expect((await me.post(`${CONTROL}/login/email`, { email: 'Olivia@acme.test', next: '/' })).html).toContain('sent a sign-in link to olivia@acme.test');
    const link = /(https:\/\/cloud\.parley\.test\/login\/link\?token=\S+)/.exec(mails.at(-1)!.text)![1]!;
    expect((await me.go(link)).html).toContain('Continue to your workspaces');
    expect((await me.go(`${CONTROL}/`)).html).not.toContain('Your workspaces');
    const token = new URL(link).searchParams.get('token')!;
    expect((await me.post(`${CONTROL}/login/link`, { token })).html).toContain('Acme');
    expect((await me.post(`${CONTROL}/login/link`, { token })).res.status).toBe(404);
  });

  test('removing a member removes the workspace from their list', async () => {
    const { cloud } = makeCloud();
    const { url, owner, tenant } = await workspace(cloud, 'acme');
    const invited = await owner.post(`${url}/admin/invites`, { role: 'member' });
    const inviteUrl = /(https:\/\/acme\.parley\.test\/invite\/[\w-]+)/.exec(invited.html)![1]!;
    const mia = browser(cloud, 'mia-dev');
    await mia.go(`${CONTROL}/auth/github?${new URLSearchParams({ workspace: tenant.id, next: new URL(inviteUrl).pathname })}`);
    const account = cloud.accounts.findByEmail('mia@acme.test')!;
    expect(cloud.accounts.memberships(account)).toHaveLength(1);
    const miaUser = cloud.accounts.memberships(account)[0]!.userId;
    await owner.post(`${url}/admin/members/${miaUser}`, { action: 'remove', confirm: 'yes' });
    expect(cloud.accounts.memberships(account)).toHaveLength(0);
  });

  test('workspaces from before accounts are mirrored once', async () => {
    const { cloud } = makeCloud();
    await workspace(cloud, 'acme');
    cloud.control.db.exec('UPDATE tenants SET members_synced_at = NULL; DELETE FROM memberships');
    expect(cloud.accounts.unsyncedTenantIds()).toHaveLength(1);
    cloud.close();
    const reopened = new Cloud(cloud['config'], {});
    clouds.push(reopened);
    reopened.syncAllMembers();
    expect(reopened.accounts.unsyncedTenantIds()).toHaveLength(0);
  });
});
