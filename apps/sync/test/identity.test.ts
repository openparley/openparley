import { describe, expect, test } from 'bun:test';
import { signAssertion, verifyAssertion, type Identity } from '../src/assertion';
import type { Mail } from '../src/mail';
import { harness, PUBLIC_URL, SETUP_TOKEN } from './harness';

const KEY = 'cloud-handoff-key';
const DOOR = { key: KEY, startUrl: 'https://cloud.test/login?workspace=w1', label: 'Continue with GitHub' };
const GITHUB: Identity = { githubId: '42', githubLogin: 'mia-dev', email: 'mia@example.com', emailVerified: true, name: 'Mia' };

function setup(options: { verifiedOwnerEmail?: string } = {}) {
  const mails: Mail[] = [];
  let changes = 0;
  const h = harness({
    config: { trustedSignIn: DOOR },
    mailer: { send: async (mail) => void mails.push(mail) },
    onMembersChanged: () => changes++,
    ...options,
  });
  const handoff = (b: ReturnType<typeof h.browser>, identity: Identity, next = '/admin', token = signAssertion(KEY, PUBLIC_URL, identity)) =>
    b.request(`/auth/handoff?${new URLSearchParams({ token, next })}`);
  return { ...h, mails, changes: () => changes, handoff };
}

describe('sign-in assertions', () => {
  test('only the right key, audience and time verify', () => {
    const token = signAssertion(KEY, PUBLIC_URL, GITHUB, 60_000, 1000);
    expect(verifyAssertion(KEY, PUBLIC_URL, token, 2000)?.identity).toMatchObject(GITHUB);
    expect(verifyAssertion('other key', PUBLIC_URL, token, 2000)).toBeNull();
    expect(verifyAssertion(KEY, 'https://elsewhere.test', token, 2000)).toBeNull();
    expect(verifyAssertion(KEY, PUBLIC_URL, token, 61_001)).toBeNull();
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), githubId: '1' })).toString('base64url');
    expect(verifyAssertion(KEY, PUBLIC_URL, `${forged}.${mac}`, 2000)).toBeNull();
  });
});

describe('hand-off from a trusted front door', () => {
  test('signs in the account with that GitHub id, once per link', async () => {
    const { repo, browser, handoff } = setup();
    await browser().post('/setup', { token: SETUP_TOKEN, name: 'Olivia', email: 'olivia@example.com', password: 'correct horse battery' });
    const olivia = repo.findActiveUserByEmail('olivia@example.com')!;
    repo.linkGithub(olivia.id, '7', 'olivia-dev');

    const b = browser();
    const token = signAssertion(KEY, PUBLIC_URL, { githubId: '7' });
    const res = await handoff(b, {}, '/admin', token);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    expect(await (await b.request('/admin')).text()).toContain('Olivia · owner');
    expect((await handoff(browser(), {}, '/admin', token)).status).toBe(400);
    // `next` stays on this server.
    expect((await handoff(browser(), { githubId: '7' }, 'https://evil.test/')).headers.get('location')).toBe('/admin');
  });

  test('matches by email only when both sides confirmed it', async () => {
    const { repo, browser, handoff } = setup();
    await browser().post('/setup', { token: SETUP_TOKEN, name: 'Olivia', email: 'olivia@example.com', password: 'correct horse battery' });
    const identity = { email: 'olivia@example.com', emailVerified: true, githubId: '7', githubLogin: 'olivia-dev' };
    // The account's address was typed at setup, never confirmed: someone else might own it.
    expect((await handoff(browser(), identity)).status).toBe(403);
    expect((await handoff(browser(), { ...identity, emailVerified: false })).status).toBe(403);

    repo.markEmailVerified(repo.findActiveUserByEmail('olivia@example.com')!.id);
    expect((await handoff(browser(), identity)).status).toBe(302);
    // Matched by email, so GitHub is linked: next time the GitHub id alone is enough.
    expect(repo.findActiveUserByGithub('7')?.email).toBe('olivia@example.com');
  });

  test('a signed-in person connects GitHub; a GitHub account belongs to one person', async () => {
    const { repo, browser, owner, invited, handoff } = setup();
    const { b } = await owner();
    expect(await (await b.request('/admin')).text()).toContain('Connect GitHub');
    expect((await handoff(b, { githubId: '7', githubLogin: 'olivia-dev' })).status).toBe(302);
    expect(await (await b.request('/admin')).text()).toContain('olivia-dev');

    const mia = await invited(b, 'member', 'mia@example.com');
    expect((await handoff(mia.b, { githubId: '7' })).status).toBe(400);
    expect(repo.findActiveUserByGithub('7')!.email).toBe('olivia@example.com');

    // A password is left, so GitHub can be disconnected.
    await b.post('/admin/github/disconnect', {});
    expect(repo.findActiveUserByGithub('7')).toBeNull();
  });

  test('an invite can be accepted with GitHub; the invited address stays the account email', async () => {
    const { repo, browser, owner, handoff, changes } = setup();
    const { b } = await owner();
    const page = await (await b.post('/admin/invites', { role: 'member', email: 'mia@acme.test' })).text();
    const invite = /\/invite\/([A-Za-z0-9_-]+)/.exec(page)![1]!;
    expect(await (await browser().request(`/invite/${invite}`)).text()).toContain('Join with GitHub');

    const before = changes();
    const res = await handoff(browser(), GITHUB, `/invite/${invite}`);
    expect(res.headers.get('location')).toBe('/admin?welcome=1');
    const mia = repo.findActiveUserByGithub('42')!;
    expect(mia).toMatchObject({ email: 'mia@acme.test', name: 'Mia', role: 'member', passwordHash: '', emailVerified: false, githubLogin: 'mia-dev' });
    expect(changes()).toBeGreaterThan(before);
    expect(repo.findUsableInvite(invite)).toBeNull();

    // No password: the password form never signs this account in.
    const login = await browser().post('/login', { email: 'mia@acme.test', password: '' });
    expect(login.status).toBe(401);
    // And GitHub can't be disconnected, it's the only way in.
    const miaBrowser = browser();
    await handoff(miaBrowser, { githubId: '42' });
    expect(await (await miaBrowser.post('/admin/github/disconnect', {})).text()).toContain('only way to sign in');
  });

  test('an invite without an address takes the confirmed GitHub email', async () => {
    const { repo, browser, owner, handoff } = setup();
    const { b } = await owner();
    const page = await (await b.post('/admin/invites', { role: 'admin' })).text();
    const invite = /\/invite\/([A-Za-z0-9_-]+)/.exec(page)![1]!;
    await handoff(browser(), GITHUB, `/invite/${invite}`);
    expect(repo.findActiveUserByGithub('42')).toMatchObject({ email: 'mia@example.com', emailVerified: true, role: 'admin' });
  });

  test('without a trusted front door there is no hand-off', async () => {
    const { browser } = harness();
    expect((await browser().request(`/auth/handoff?token=${signAssertion(KEY, PUBLIC_URL, GITHUB)}`)).status).toBe(404);
  });
});

describe('confirming an email address', () => {
  test('the owner who sets up with the address the host confirmed starts confirmed', async () => {
    const { repo, browser } = setup({ verifiedOwnerEmail: 'Olivia@Example.com' });
    await browser().post('/setup', { token: SETUP_TOKEN, name: 'Olivia', email: 'olivia@example.com', password: 'correct horse battery' });
    expect(repo.findActiveUserByEmail('olivia@example.com')!.emailVerified).toBe(true);
  });

  test('a link sent to the address confirms it; opening it alone does nothing', async () => {
    const { repo, owner, mails, browser } = setup();
    const { b } = await owner();
    expect(await (await b.request('/admin')).text()).toContain('Send the confirmation email');
    expect(await (await b.post('/admin/email-confirmation', {})).text()).toContain('sent a link to olivia@example.com');
    const link = /(http:\/\/\S+\/confirm-email\/\S+)/.exec(mails.at(-1)!.text)![1]!;
    expect(mails.at(-1)!.to).toBe('olivia@example.com');
    const path = new URL(link).pathname;

    const anyone = browser();
    expect(await (await anyone.request(path)).text()).toContain('Confirm my email');
    expect(repo.findActiveUserByEmail('olivia@example.com')!.emailVerified).toBe(false);
    expect(await (await anyone.post(path, {})).text()).toContain('is confirmed');
    expect(repo.findActiveUserByEmail('olivia@example.com')!.emailVerified).toBe(true);
    expect((await anyone.post(path, {})).status).toBe(404);
    expect(await (await b.request('/admin')).text()).not.toContain('Send the confirmation email');
  });
});

describe('member changes', () => {
  test('the host hears about joins, role changes and removals', async () => {
    const { repo, owner, invited, changes } = setup();
    const { b } = await owner();
    const afterSetup = changes();
    expect(afterSetup).toBeGreaterThan(0);
    await invited(b, 'member', 'mia@example.com');
    const mia = repo.findActiveUserByEmail('mia@example.com')!;
    expect(changes()).toBe(afterSetup + 1);
    repo.setRole(mia.id, 'admin');
    repo.removeUser(mia.id);
    expect(changes()).toBe(afterSetup + 3);
  });
});
