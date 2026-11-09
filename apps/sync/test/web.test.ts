import { describe, expect, test } from 'bun:test';
import type { Mail } from '../src/mail';
import { PUBLIC_URL, SETUP_TOKEN, SITE, harness } from './harness';

describe('first-run setup', () => {
  test('requires the setup token and only works once', async () => {
    const { browser, repo } = harness();
    const b = browser();
    expect((await b.request('/setup')).status).toBe(403);
    expect((await b.request(`/setup?token=${SETUP_TOKEN}`)).status).toBe(200);
    expect((await b.post('/setup', { token: 'wrong', name: 'X', email: 'x@example.com', password: 'long enough pw' })).status).toBe(403);

    const res = await b.post('/setup', { token: SETUP_TOKEN, name: 'Olivia', email: 'Olivia@Example.com', password: 'long enough pw' });
    expect(res.status).toBe(302);
    expect(repo.listActiveUsers().map((u) => [u.email, u.role])).toEqual([['olivia@example.com', 'owner']]);

    const again = await browser().post('/setup', { token: SETUP_TOKEN, name: 'Mallory', email: 'm@example.com', password: 'long enough pw' });
    expect(again.headers.get('location')).toBe('/login');
    expect(repo.listActiveUsers()).toHaveLength(1);
  });

  test('rejects weak passwords with a readable message', async () => {
    const { browser } = harness();
    const res = await browser().post('/setup', { token: SETUP_TOKEN, name: 'O', email: 'o@example.com', password: 'short' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('at least 10 characters');
  });
});

describe('sign in', () => {
  test('wrong passwords fail and attempts are rate limited', async () => {
    const { owner, browser } = harness();
    await owner();
    const b = browser();
    expect((await b.post('/login', { email: 'olivia@example.com', password: 'nope nope nope' })).status).toBe(401);
    for (let i = 0; i < 9; i++) await b.post('/login', { email: 'olivia@example.com', password: 'nope nope nope' });
    expect((await b.post('/login', { email: 'olivia@example.com', password: 'correct horse battery' })).status).toBe(429);
  });

  test('redirects only to local paths after login', async () => {
    const { owner, browser } = harness();
    await owner();
    const res = await browser().post('/login', { email: 'olivia@example.com', password: 'correct horse battery', next: '//evil.test/' });
    expect(res.headers.get('location')).toBe('/admin');
  });

  test('cross-site form posts are rejected', async () => {
    const { owner, browser } = harness();
    await owner();
    const res = await browser().post('/login', { email: 'olivia@example.com', password: 'correct horse battery' }, { origin: 'https://evil.test' });
    expect(res.status).toBe(403);
  });
});

describe('connect popup', () => {
  test('only hands out tokens to origins registered on the project', async () => {
    const { owner } = harness();
    const { b, project } = await owner();
    expect((await b.request(`/connect?project=nope&origin=${SITE}`)).status).toBe(404);
    const denied = await b.request(`/connect?project=${project.id}&origin=${encodeURIComponent('https://evil.test')}`);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('"token"');
    for (const bad of ['', 'null', 'https://*.evil.test', 'https://evil.test/path']) {
      expect((await b.request(`/connect?project=${project.id}&origin=${encodeURIComponent(bad)}`)).status).toBe(400);
    }
  });

  test('an admin adds a new site in one click; the token follows only after that', async () => {
    const { owner, repo } = harness();
    const { b, project } = await owner();
    const preview = 'http://localhost:5173';
    const ask = await b.request(`/connect?project=${project.id}&origin=${encodeURIComponent(preview)}`);
    const html = await ask.text();
    expect(html).toContain('Add this site?');
    expect(html).toContain('Only add sites you run');
    expect(html).not.toContain('"token"');
    expect(repo.findProject(project.id)!.origins).toEqual([SITE]);

    const add = await b.post('/connect/allow', { project: project.id, origin: preview });
    expect(add.status).toBe(303);
    expect(repo.findProject(project.id)!.origins).toEqual([SITE, preview]);
    const signedIn = await (await b.request(add.headers.get('location')!)).text();
    expect(signedIn).toContain(`postMessage(message, "${preview}")`);

    // Adding again is a no-op; a wildcard or garbage can't be smuggled in through the popup.
    await b.post('/connect/allow', { project: project.id, origin: preview });
    expect((await b.post('/connect/allow', { project: project.id, origin: 'https://*.evil.test' })).status).toBe(400);
    expect(repo.findProject(project.id)!.origins).toEqual([SITE, preview]);
  });

  test('members are told to ask an admin and can\'t add sites; forms from other sites are refused', async () => {
    const { owner, invited, repo } = harness();
    const { b, project } = await owner();
    const member = await invited(b, 'member', 'max@example.com');
    const res = await member.b.request(`/connect?project=${project.id}&origin=${encodeURIComponent('https://new.test')}`);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Ask an admin');
    expect(html).not.toContain('/connect/allow');
    expect((await member.b.post('/connect/allow', { project: project.id, origin: 'https://new.test' })).status).toBe(403);
    expect((await b.post('/connect/allow', { project: project.id, origin: 'https://new.test' }, { origin: 'https://evil.test' })).status).toBe(403);
    expect(repo.findProject(project.id)!.origins).toEqual([SITE]);
  });

  test('a wildcard site signs in its subdomains', async () => {
    const { owner, repo } = harness();
    const { b, project } = await owner();
    await b.post(`/admin/projects/${project.id}`, { name: 'Shop', origins: `${SITE}\nhttps://*.preview.shop.test` });
    expect(repo.findProject(project.id)!.origins).toEqual([SITE, 'https://*.preview.shop.test']);
    const res = await b.request(`/connect?project=${project.id}&origin=${encodeURIComponent('https://pr-7.preview.shop.test')}`);
    expect(await res.text()).toContain('postMessage(message, "https://pr-7.preview.shop.test")');
    expect((await b.request(`/connect?project=${project.id}&origin=${encodeURIComponent('https://preview.shop.test')}`)).status).toBe(403);
  });

  test('sends signed-out users to the login page and back', async () => {
    const { owner, browser } = harness();
    const { project } = await owner();
    const res = await browser().request(`/connect?project=${project.id}&origin=${encodeURIComponent(SITE)}`);
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get('location')!)).toBe(`/login?next=/connect?project=${project.id}&origin=${encodeURIComponent(SITE)}`);
  });

  test('posts the token only to the requesting origin and forbids framing', async () => {
    const { owner } = harness();
    const { b, project } = await owner();
    const res = await b.request(`/connect?project=${project.id}&origin=${encodeURIComponent(SITE)}`);
    const html = await res.text();
    expect(html).toContain(`postMessage(message, "${SITE}")`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('admin', () => {
  test('validates project origins', async () => {
    const { owner, repo } = harness();
    const { b } = await owner();
    const res = await b.post('/admin/projects', { name: 'Bad', origins: 'https://example.com/path' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('without a path');
    expect(await (await b.post('/admin/projects', { name: 'Broad', origins: 'https://*.com' })).text()).toContain('too broad');
    await b.post('/admin/projects', { name: 'Two', origins: 'https://a.test\nhttp://localhost:5173 https://a.test' });
    expect(repo.listProjects().at(-1)!.origins).toEqual(['https://a.test', 'http://localhost:5173']);
  });

  test('each project offers a setup prompt for coding agents with its own values filled in', async () => {
    const { owner } = harness();
    const { b, project } = await owner();
    const res = await b.request('/admin');
    const html = await res.text();
    const tag = `&lt;script src=&quot;${PUBLIC_URL}/openparley.js&quot; data-project=&quot;${project.id}&quot; data-launcher=&quot;members&quot; defer&gt;`;
    expect(html).toContain(`id="prompt-${project.id}"`);
    expect(html).toContain(tag);
    expect(html).toContain(`claude mcp add --scope project --transport http openparley ${PUBLIC_URL}/mcp`);
    expect(html).not.toContain('YOUR_PROJECT_KEY');
    // The toggle swaps in the every-visitor variant of both the snippet and the prompt.
    expect(html).toContain(`data-always="&lt;script src=&quot;${PUBLIC_URL}/openparley.js&quot; data-project=&quot;${project.id}&quot; defer&gt;&lt;/script&gt;"`);
    expect(html).toContain('Open the app and sign in from the OpenParley button');
    // The copy button's script must carry this response's CSP nonce, or the browser blocks it.
    const nonce = res.headers.get('content-security-policy')!.match(/'nonce-([^']+)'/)![1];
    expect(html).toContain(`<script nonce="${nonce}">document.addEventListener(`);
  });

  test('members cannot manage projects', async () => {
    const { owner, invited } = harness();
    const { b } = await owner();
    const member = await invited(b, 'member', 'mo@example.com');
    expect((await member.b.post('/admin/projects', { name: 'X', origins: SITE })).status).toBe(403);
  });

  test('invite links work exactly once', async () => {
    const { owner, invited, browser, repo } = harness();
    const { b } = await owner();
    const { link } = await invited(b, 'admin', 'ada@example.com');
    expect(repo.findActiveUserByEmail('ada@example.com')?.role).toBe('admin');
    const reuse = await browser().post(`/invite/${link}`, { name: 'Eve', email: 'eve@example.com', password: 'another long password' });
    expect(reuse.status).toBe(404);
    expect(repo.findActiveUserByEmail('eve@example.com')).toBeNull();
  });

  test('a whole office behind one IP can accept invites; only failures are rate limited', async () => {
    const { owner, invited, browser, repo } = harness();
    const { b } = await owner();
    for (let i = 0; i < 12; i++) await invited(b, 'member', `person${i}@example.com`);
    expect(repo.listActiveUsers()).toHaveLength(13);

    const guesser = browser();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await guesser.post(`/invite/guess${i}`, { name: 'X', email: `x${i}@example.com`, password: 'another long password' })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  test('invite tokens are never put in a redirect URL', async () => {
    const { owner } = harness();
    const { b } = await owner();
    const res = await b.post('/admin/invites', { role: 'member' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`${PUBLIC_URL}/invite/`);
  });

  test('removed members lose access immediately', async () => {
    const { owner, invited, api, repo } = harness();
    const { b, project } = await owner();
    const member = await invited(b, 'member', 'mo@example.com');
    const call = api(await member.b.connect(project.id));
    expect((await call('GET', '/me')).status).toBe(200);
    const id = repo.findActiveUserByEmail('mo@example.com')!.id;
    await b.post(`/admin/members/${id}`, { action: 'remove', confirm: 'yes' });
    expect((await call('GET', '/me')).status).toBe(401);
    expect((await member.b.post('/login', { email: 'mo@example.com', password: 'another long password' })).status).toBe(401);
  });
});

describe('invites by email', () => {
  test('an admin invites by email: the mail has the link, replies go to the inviter, and the invite shows who it is for', async () => {
    const mails: Mail[] = [];
    const { owner, browser, repo } = harness({ mailer: { send: async (mail) => void mails.push(mail) } });
    const { b } = await owner();
    const page = await (await b.post('/admin/invites', { email: 'Pat@Example.com', role: 'member' })).text();
    expect(page).toContain('Invite sent to pat@example.com');
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'pat@example.com', replyTo: 'olivia@example.com', subject: 'Olivia Owner invited you to OpenParley' });
    expect(mails[0]!.text).toContain('review Shop with OpenParley');
    const link = /(http:\/\/parley\.test\/invite\/[\w-]+)/.exec(mails[0]!.text)![1]!;
    expect(page).toContain(link);
    expect(await (await b.request('/admin')).text()).toContain('pat@example.com (member)');
    expect(repo.listPendingInvites()[0]!.email).toBe('pat@example.com');

    // The invite page has the address filled in; accepting lands on a welcome with the team's sites.
    const pat = browser();
    const path = new URL(link).pathname;
    expect(await (await pat.request(path)).text()).toContain('value="pat@example.com"');
    const accepted = await pat.post(path, { name: 'Pat', email: 'pat@example.com', password: 'another long password' });
    expect(accepted.headers.get('location')).toBe('/admin?welcome=1');
    const welcome = await (await pat.request('/admin?welcome=1')).text();
    expect(welcome).toContain('Welcome, Pat.');
    expect(welcome).toContain(`href="${SITE}/#openparley"`);
  });

  test('without mail, or when it fails, the admin gets the link to send themselves', async () => {
    const off = harness();
    const a = await off.owner();
    const page = await (await a.b.post('/admin/invites', { email: 'pat@example.com', role: 'member' })).text();
    expect(page).toContain('send email, so send it to them yourself');
    expect(page).toMatch(/\/invite\/[\w-]+/);

    const broken = harness({ mailer: { send: async () => Promise.reject(new Error('down')) } });
    const b = await broken.owner();
    expect(await (await b.b.post('/admin/invites', { email: 'pat@example.com', role: 'member' })).text()).toContain('email pat@example.com, so send it');
    expect((await b.b.post('/admin/invites', { email: 'not an email', role: 'member' })).status).toBe(400);
  });

  test('the sites list skips wildcards', async () => {
    const { owner, repo } = harness();
    const { b, project } = await owner();
    repo.updateProject(project.id, 'Shop', [SITE, 'https://*.preview.shop.test']);
    const page = await (await b.request('/admin')).text();
    expect(page).toContain(`href="${SITE}/#openparley"`);
    expect(page).not.toContain('href="https://*.preview');
  });
});
