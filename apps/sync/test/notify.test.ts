import { describe, expect, test } from 'bun:test';
import type { Thread } from '@openparley/protocol';
import type { Mail, Mailer } from '../src/mail';
import { openDatabase } from '../src/db';
import { mentionedIds } from '../src/mentions';
import { Repo } from '../src/repo';
import { PUBLIC_URL, SITE, anchor, harness } from './harness';

const SECOND = 1000;

/** A team of three with a captured mailbox and a clock the test moves. */
async function team(options: { mailer?: Mailer | null } = {}) {
  let now = 1_000_000;
  const sent: Mail[] = [];
  const mailer = options.mailer === undefined ? { send: async (mail: Mail) => void sent.push(mail) } : options.mailer;
  const h = harness({ mailer, now: () => now });
  const olivia = await h.owner();
  const join = async (email: string) => {
    const { b } = await h.invited(olivia.b, 'member', email);
    return { b, call: h.api(await b.connect(olivia.project.id)) };
  };
  const mia = await join('mia@example.com');
  const dev = await join('dev@example.com');
  const start = async (call: typeof olivia.call, body: string, page = '/pricing') =>
    ((await (await call('POST', '/threads', { project: olivia.project.id, page, anchor, body })).json()) as { thread: Thread }).thread;
  const reply = (call: typeof olivia.call, thread: Thread, body: string) => call('POST', `/threads/${thread.id}/comments`, { body });
  const later = async (ms: number) => {
    now += ms;
    return h.notifier.deliver();
  };
  const inbox = (email: string) => sent.filter((mail) => mail.to === email);
  return { ...h, olivia, mia, dev, start, reply, later, sent, inbox };
}

describe('mentions', () => {
  const members = [
    { id: 'o', name: 'Olivia Owner', handle: 'olivia' },
    { id: 's', name: 'Sam', handle: 'sam' },
    { id: 'ss', name: 'Sam Smith', handle: 'sam.smith' },
    { id: 'm', name: 'Mia', handle: 'mia' },
  ];

  test('handles, Slack-style, case-insensitive, ending before sentence punctuation', () => {
    expect(mentionedIds('@olivia can you look?', members)).toEqual(new Set(['o']));
    expect(mentionedIds('cc @Olivia.', members)).toEqual(new Set(['o']));
    expect(mentionedIds('@sam.smith and @sam', members)).toEqual(new Set(['ss', 's']));
    expect(mentionedIds('(@mia)', members)).toEqual(new Set(['m']));
  });

  test('full names still work, and the longest reading wins', () => {
    expect(mentionedIds('@Olivia Owner should this be green?', members)).toEqual(new Set(['o']));
    expect(mentionedIds('@Sam Smith, not @Sam.', members)).toEqual(new Set(['ss', 's']));
  });

  test('not inside words or email addresses, and only whole handles', () => {
    expect(mentionedIds('mail mia@example.com', members)).toEqual(new Set());
    expect(mentionedIds('@miami trip', members)).toEqual(new Set());
    expect(mentionedIds('@olivia2', members)).toEqual(new Set());
    expect(mentionedIds('no mentions here', members)).toEqual(new Set());
  });
});

describe('mention names', () => {
  test('generated from the name: first name, else full name, else numbered; never reused', async () => {
    const { repo } = harness();
    const make = (name: string) => repo.createUser({ name, email: `${Math.random()}@example.com`, passwordHash: 'x', role: 'member' }).handle;
    expect(make('Mia Designer')).toBe('mia');
    expect(make('Mia Developer')).toBe('mia.developer');
    expect(make('Mia Developer')).toBe('mia2');
    expect(make('Zoë Ångström-Berg')).toBe('zoe');
    expect(make('李')).toBe('member');
    const leaving = repo.createUser({ name: 'Quinn', email: 'q@example.com', passwordHash: 'x', role: 'member' });
    repo.removeUser(leaving.id);
    expect(make('Quinn QA')).toBe('quinn.qa');
  });

  test('everyone changes their own on the admin page; taken and malformed names are refused', async () => {
    const { repo, olivia, mia } = await team();
    const id = repo.findActiveUserByEmail('mia@example.com')!.id;
    expect(await (await mia.b.request('/admin')).text()).toContain('value="mia"');

    const saved = await mia.b.post('/admin/handle', { handle: '@Mia.Designer' });
    expect(saved.headers.get('location')).toBe('/admin?saved=handle#notifications');
    expect(repo.findActiveUser(id)!.handle).toBe('mia.designer');
    expect(await (await mia.b.request('/admin?saved=handle')).text()).toContain('Teammates mention you as @mia.designer.');

    expect(await (await mia.b.post('/admin/handle', { handle: 'olivia' })).text()).toContain('@olivia is taken.');
    for (const bad of ['mia designer', 'mia.', '', 'x'.repeat(31)]) expect((await mia.b.post('/admin/handle', { handle: bad })).status).toBe(400);
    expect(repo.findActiveUser(id)!.handle).toBe('mia.designer');

    // Admins see everyone's mention name next to their name.
    expect(await (await olivia.b.request('/admin')).text()).toContain('<span class="muted">@mia.designer</span>');
  });

  test('accounts from before mention names get one when the database opens', () => {
    const db = openDatabase(':memory:');
    db.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('a', 'a@x', 'Ann Lee', 'x', 'owner', 1), ('b', 'b@x', 'Ann Lee', 'x', 'member', 2)`);
    const repo = new Repo(db);
    expect(repo.listActiveUsers().map((u) => u.handle)).toEqual(['ann', 'ann.lee']);
  });
});

describe('notifications', () => {
  test('a reply reaches the people in the thread, never its author, once the thread has been quiet a minute', async () => {
    const { olivia, mia, dev, start, reply, later, sent, inbox } = await team();
    const thread = await start(mia.call, 'The price is cut off on mobile');
    await reply(dev.call, thread, 'Looking into it');
    await reply(dev.call, thread, 'Fixed in a1b2c3');

    expect(await later(59 * SECOND)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await later(1 * SECOND)).toBe(1);

    // Mia started it; Olivia isn't in it and didn't ask for everything; Dev wrote the replies.
    expect(sent.map((mail) => mail.to)).toEqual(['mia@example.com']);
    const [mail] = inbox('mia@example.com');
    expect(mail!.subject).toBe('2 updates on a thread on Shop /pricing');
    expect(mail!.text).toContain('dev:\n  Looking into it');
    expect(mail!.text).toContain('dev:\n  Fixed in a1b2c3');
    expect(mail!.text).toContain(`Open the thread: ${SITE}/pricing#parley=t.${thread.id}`);
    expect(mail!.text).toContain(`${PUBLIC_URL}/admin#notifications`);
    expect(mail!.headers!['List-Unsubscribe']).toMatch(new RegExp(`^<${PUBLIC_URL}/unsubscribe/[\\w-]+>$`));
    expect(mail!.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    // Delivered once.
    expect(await later(10 * 60 * SECOND)).toBe(0);
    void olivia;
  });

  test('a busy thread still delivers after ten minutes, and several quiet threads arrive in one email', async () => {
    const { mia, dev, start, reply, later, inbox } = await team();
    const busy = await start(mia.call, 'Hero copy');
    for (let i = 0; i < 12; i++) {
      await reply(dev.call, busy, `Try ${i}`);
      expect(await later(50 * SECOND)).toBe(i < 11 ? 0 : 1);
    }
    expect(inbox('mia@example.com')).toHaveLength(1);
    expect(inbox('mia@example.com')[0]!.subject).toBe('12 updates on a thread on Shop /pricing');

    const a = await start(mia.call, 'Footer', '/');
    const b = await start(mia.call, 'Logo', '/about');
    await reply(dev.call, a, 'ok');
    await reply(dev.call, b, 'ok too');
    await later(60 * SECOND);
    const digest = inbox('mia@example.com')[1]!;
    expect(digest.subject).toBe('2 threads with news in Shop');
    expect(digest.text).toContain('Thread on "Buy" · Shop /about');
  });

  test('a mention reaches anyone, and makes them part of the thread from then on', async () => {
    const { olivia, mia, dev, start, reply, later, inbox } = await team();
    const thread = await start(mia.call, '@Olivia Owner should this be green?');
    await later(60 * SECOND);
    expect(inbox('olivia@example.com')[0]!.subject).toBe('mia mentioned you on Shop /pricing');
    expect(inbox('olivia@example.com')[0]!.text).toContain('New thread on "Buy" · Shop /pricing');
    expect(inbox('olivia@example.com')[0]!.text).toContain('mia (mentioned you):\n  @Olivia Owner should this be green?');
    expect(inbox('dev@example.com')).toHaveLength(0);

    await reply(dev.call, thread, 'I can do it');
    await later(60 * SECOND);
    expect(inbox('olivia@example.com')).toHaveLength(2);
    void olivia;
  });

  test('levels: nothing, mentions only, everything, and per project', async () => {
    const { repo, olivia, mia, dev, start, reply, later, inbox } = await team();
    const other = repo.createProject('Blog', [SITE]);
    const user = (email: string) => repo.findActiveUserByEmail(email)!;

    repo.saveNotificationLevels(user('olivia@example.com').id, 'everything', { [other.id]: 'off' });
    repo.saveNotificationLevels(user('dev@example.com').id, 'mentions', {});
    const thread = await start(mia.call, 'Contrast is low');
    await reply(olivia.call, thread, 'Agreed');
    await reply(mia.call, thread, '@dev can you pick this up?');
    await later(60 * SECOND);
    expect(inbox('olivia@example.com').map((m) => m.subject)).toEqual(['mia replied on Shop /pricing']);
    expect(inbox('dev@example.com').map((m) => m.subject)).toEqual(['mia mentioned you on Shop /pricing']);

    // Olivia switched the Blog project off.
    await mia.call('POST', '/threads', { project: other.id, page: '/', anchor, body: 'Typo' });
    // Dev asked for mentions only: Mia's reply to a thread Dev is in doesn't count.
    await reply(mia.call, thread, 'Thanks!');
    repo.saveNotificationLevels(user('mia@example.com').id, 'off', {});
    await reply(dev.call, thread, '@mia done');
    await later(60 * SECOND);
    expect(inbox('olivia@example.com')).toHaveLength(2);
    expect(inbox('dev@example.com')).toHaveLength(1);
    expect(inbox('mia@example.com')).toHaveLength(0);
  });

  test('replying yourself drops what was waiting for you about that thread; deleted comments are skipped', async () => {
    const { mia, dev, start, reply, later, inbox, olivia } = await team();
    const thread = await start(mia.call, 'Spacing');
    await reply(dev.call, thread, 'Which spacing?');
    await reply(mia.call, thread, 'Between the cards');
    const res = await reply(mia.call, thread, 'oops, wrong thread');
    const { thread: updated } = (await res.json()) as { thread: Thread };
    await mia.call('DELETE', `/threads/${thread.id}/comments/${updated.comments.at(-1)!.id}`);
    await later(60 * SECOND);
    // Mia answered Dev's question, so she has seen it; Dev hears about the answer, not the deleted comment.
    expect(inbox('mia@example.com')).toHaveLength(0);
    expect(inbox('dev@example.com').map((m) => m.subject)).toEqual(['mia replied on Shop /pricing']);
    expect(inbox('dev@example.com')[0]!.text).not.toContain('oops');
    void olivia;
  });

  test('resolving tells the people in the thread; deleting a thread drops its notifications', async () => {
    const { repo, mia, dev, start, later, inbox } = await team();
    const thread = await start(mia.call, 'Broken link');
    await dev.call('PATCH', `/threads/${thread.id}`, { status: 'resolved' });
    await dev.call('PATCH', `/threads/${thread.id}`, { status: 'resolved' });
    await later(60 * SECOND);
    expect(inbox('mia@example.com').map((m) => m.subject)).toEqual(['dev resolved a thread on Shop /pricing']);
    expect(inbox('mia@example.com')[0]!.text).toContain('dev resolved the thread.');

    const gone = await start(mia.call, '@dev look');
    await mia.call('DELETE', `/threads/${gone.id}`);
    expect(repo.hasPendingNotifications()).toBe(false);
  });

  test("an agent's reply notifies people (marked as the agent's), but not the agent's own user", async () => {
    const { app, olivia, mia, start, later, inbox } = await team();
    const html = await (await olivia.b.post('/admin/agents', { name: 'Claude Code' })).text();
    const token = /Bearer (opa_[\w-]+)/.exec(html)![1]!;
    const thread = await start(mia.call, 'Make the button bigger');
    const res = await app.request(`${PUBLIC_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resolve_thread', arguments: { id: thread.id, body: 'Done in Button.tsx' } } }),
    });
    expect(res.status).toBe(200);
    await later(60 * SECOND);
    expect(inbox('olivia@example.com')).toHaveLength(0);
    const [mail] = inbox('mia@example.com');
    expect(mail!.subject).toBe('2 updates on a thread on Shop /pricing');
    expect(mail!.text).toContain('Claude Code (agent for Olivia Owner):\n  Done in Button.tsx');
    expect(mail!.text).toContain('Claude Code (agent for Olivia Owner) resolved the thread.');
  });

  test('unsubscribing: opening the link changes nothing, the button or a one-click POST switches email off', async () => {
    const { app, repo, mia, dev, start, reply, later, inbox, browser } = await team();
    const thread = await start(mia.call, 'Hello');
    await reply(dev.call, thread, 'Hi');
    await later(60 * SECOND);
    const url = /<(.+)>/.exec(inbox('mia@example.com')[0]!.headers!['List-Unsubscribe']!)![1]!;
    const path = new URL(url).pathname;

    expect(await (await app.request(url)).text()).toContain('Stop notification emails?');
    expect(repo.notificationSettings(repo.findActiveUserByEmail('mia@example.com')!.id).channels).toEqual({});

    // Mail clients post from nowhere: no Origin, no cookie.
    const oneClick = await app.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(oneClick.status).toBe(200);
    expect(await oneClick.text()).toContain('You&#39;re unsubscribed');
    await reply(dev.call, thread, 'Still there?');
    expect(repo.hasPendingNotifications()).toBe(false);
    await later(60 * SECOND);
    expect(inbox('mia@example.com')).toHaveLength(1);

    expect((await browser().request('/unsubscribe/not-a-token')).status).toBe(404);
    void path;
  });

  test('settings page: levels per project and channel switches', async () => {
    const { repo, mia, olivia } = await team();
    const blog = repo.createProject('Blog', [SITE]);
    const shop = olivia.project;
    const page = await (await mia.b.request('/admin')).text();
    expect(page).toContain('id="notifications"');
    expect(page).toContain('In all projects, notify me about');
    expect(page).toContain('name="channel:email" checked=""');

    const saved = await mia.b.post('/admin/notifications', { level: 'mentions', [`project:${shop.id}`]: 'everything', [`project:${blog.id}`]: 'mentions' });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/admin?saved=notifications#notifications');
    const id = repo.findActiveUserByEmail('mia@example.com')!.id;
    // An override equal to the default isn't stored, so changing the default later still applies.
    expect(repo.notificationSettings(id)).toEqual({ level: 'mentions', projects: { [shop.id]: 'everything' }, channels: { email: false } });
    expect(await (await mia.b.request('/admin?saved=notifications')).text()).toContain('Notification settings saved.');

    await mia.b.post('/admin/notifications', { level: 'bogus', 'channel:email': 'on' });
    expect(repo.notificationSettings(id)).toEqual({ level: 'participating', projects: {}, channels: { email: true } });
  });

  test('without a mailer nothing is queued and the page says so', async () => {
    const { repo, mia, dev, start, reply } = await team({ mailer: null });
    const thread = await start(mia.call, '@dev hi');
    await reply(dev.call, thread, 'hi');
    expect(repo.hasPendingNotifications()).toBe(false);
    expect(await (await mia.b.request('/admin')).text()).toContain('This server doesn&#39;t send notifications yet.');
  });

  test('failed sends are retried, then given up on', async () => {
    let fail = true;
    const sent: Mail[] = [];
    const { repo, mia, dev, start, later } = await team({
      mailer: {
        send: async (mail) => {
          if (fail) throw new Error('Resend is down');
          sent.push(mail);
        },
      },
    });
    const error = console.error;
    console.error = () => {};
    try {
      const thread = await start(mia.call, 'a');
      await dev.call('POST', `/threads/${thread.id}/comments`, { body: 'b' });
      expect(await later(60 * SECOND)).toBe(0);
      expect(repo.hasPendingNotifications()).toBe(true);
      fail = false;
      expect(await later(15 * SECOND)).toBe(1);
      expect(sent).toHaveLength(1);

      fail = true;
      await dev.call('POST', `/threads/${thread.id}/comments`, { body: 'c' });
      for (let i = 0; i < 5; i++) await later(60 * SECOND);
      expect(repo.hasPendingNotifications()).toBe(false);
    } finally {
      console.error = error;
    }
  });

  test('members are listed with their mention names, and nothing else about them', async () => {
    const { mia } = await team();
    const res = await mia.call('GET', '/members');
    expect(await res.json()).toEqual({
      members: [
        { id: expect.any(String), name: 'Olivia Owner', handle: 'olivia' },
        { id: expect.any(String), name: 'mia', handle: 'mia' },
        { id: expect.any(String), name: 'dev', handle: 'dev' },
      ],
    });
  });
});
