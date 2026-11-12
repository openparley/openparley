import { expect, request, test, type BrowserContext, type Page } from '@playwright/test';
import { SITE_URL, SYNC_URL } from './playwright.config';

test.describe.configure({ mode: 'serial' });

let projectId = '';
let inviteLink = '';

test.beforeAll(async () => {
  const admin = await request.newContext({ baseURL: SYNC_URL, extraHTTPHeaders: { origin: SYNC_URL } });
  const owner = { name: 'Olivia', email: 'olivia@example.com', password: 'correct horse battery' };
  // Setup only succeeds on a fresh database; signing in covers repeated runs against the same server.
  await admin.post('/setup', { form: { token: 'e2e-setup', ...owner } });
  await admin.post('/login', { form: owner });
  await admin.post('/admin/projects', { form: { name: 'Shop', origins: SITE_URL } });
  const projects = [...(await (await admin.get('/admin')).text()).matchAll(/data-project=(?:&quot;|")([\w-]+)/g)];
  projectId = projects.at(-1)![1]!;
  inviteLink = /(http:\/\/localhost:4174\/invite\/[\w-]+)/.exec(await (await admin.post('/admin/invites', { form: { role: 'member' } })).text())![1]!;
  await admin.dispose();
});

/** A host page on the allowed origin that embeds the overlay from the sync server. */
async function teamPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${SITE_URL}/team.html?project=${projectId}`);
  await page.getByRole('button', { name: /^Show threads/ }).click();
  return page;
}

async function signIn(page: Page, credentials?: { email: string; password: string }) {
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const popup = await popupPromise;
  if (credentials) {
    await popup.getByLabel('Email').fill(credentials.email);
    await popup.getByLabel('Password').fill(credentials.password);
    await popup.getByRole('button', { name: 'Sign in' }).click();
  }
  // Already-signed-in users get a popup that closes almost instantly, possibly before a
  // 'close' listener could be attached, so poll the state instead of waiting for the event.
  await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);
  await expect(page.getByRole('toolbar', { name: 'OpenParley' }).getByRole('button', { name: 'Comment' })).toBeVisible();
}

test('teammates see and answer each other’s threads', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const owner = await teamPage(ownerContext);
  await signIn(owner, { email: 'olivia@example.com', password: 'correct horse battery' });

  await owner.keyboard.press('c');
  await owner.locator('#cta').click();
  const compose = owner.getByRole('dialog', { name: 'New thread' });
  await expect(compose.getByLabel('Your name')).toHaveCount(0);
  await compose.getByRole('textbox', { name: /on your mind/ }).fill('Should say "Start free trial"');
  await compose.getByRole('button', { name: 'Post' }).click();
  const ownerCard = owner.getByRole('dialog', { name: 'Thread' });
  await expect(ownerCard.getByText('Olivia', { exact: true })).toBeVisible();

  // A new teammate accepts the invite; being signed in on the server makes the popup close by itself.
  const memberContext = await browser.newContext();
  const invite = await memberContext.newPage();
  await invite.goto(inviteLink);
  await invite.getByLabel('Name').fill('Max');
  await invite.getByLabel('Email').fill(`max+${Date.now()}@example.com`);
  await invite.getByLabel('Password').fill('another long password');
  await invite.getByRole('button', { name: 'Create account' }).click();
  await expect(invite).toHaveURL(`${SYNC_URL}/admin?welcome=1`);
  await expect(invite.getByText('Welcome, Max.')).toBeVisible();
  // The welcome lists the team's sites; following one switches OpenParley on there.
  await expect(invite.getByRole('link', { name: 'Open', exact: true }).first()).toHaveAttribute('href', `${SITE_URL}/#openparley`);

  const member = await teamPage(memberContext);
  await signIn(member);
  await member.getByRole('button', { name: /^Thread by Olivia/ }).click();
  const memberCard = member.getByRole('dialog', { name: 'Thread' });
  await expect(memberCard.getByText('Should say "Start free trial"')).toBeVisible();
  await expect(memberCard.getByRole('button', { name: 'Delete thread' })).toHaveCount(0);
  await memberCard.getByRole('textbox', { name: 'Reply' }).fill('On it');
  await memberCard.getByRole('button', { name: 'Reply' }).click();
  await expect(memberCard.getByText('On it')).toBeVisible();

  // @ suggests teammates with their mention names, Slack-style; the keyboard picks one, Esc closes the list but not the thread.
  const reply = memberCard.getByRole('textbox', { name: 'Reply' });
  const suggestions = memberCard.getByRole('listbox', { name: 'Mention someone' });
  await reply.pressSequentially('@');
  await expect(suggestions.getByRole('option')).toHaveText(['OOlivia@olivia', 'MMax@max']);
  await reply.press('Escape');
  await expect(suggestions).toHaveCount(0);
  await expect(memberCard).toBeVisible();
  await reply.fill('');
  await reply.pressSequentially('Done, @ol');
  await expect(suggestions.getByRole('option', { selected: true })).toHaveText('OOlivia@olivia');
  await reply.press('Enter');
  await expect(reply).toHaveValue('Done, @olivia ');
  await reply.pressSequentially('can you check?');
  await memberCard.getByRole('button', { name: 'Reply' }).click();
  // Mentions of current members are highlighted.
  await expect(memberCard.locator('.mention')).toHaveText('@olivia');

  // The @ button opens the same list without typing.
  await memberCard.getByRole('button', { name: 'Mention someone' }).click();
  await expect(reply).toHaveValue('@');
  await expect(reply).toBeFocused();
  await suggestions.getByRole('option', { name: /Max/ }).click();
  await expect(reply).toHaveValue('@max ');
  await reply.fill('');

  // The owner's overlay refreshes when the tab regains focus.
  await owner.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(ownerCard.getByText('On it')).toBeVisible();
  await expect(ownerCard.getByRole('button', { name: 'Delete thread' })).toBeVisible();

  // Team links carry only the id; the content comes from the server.
  await ownerContext.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ownerCard.getByRole('button', { name: 'Copy link to this thread' }).click();
  const link = await owner.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#parley=t\.[\w-]+$/);
  const shared = await memberContext.newPage();
  await shared.goto(link);
  await expect(shared.getByRole('dialog', { name: 'Thread' }).getByText('On it')).toBeVisible();

  await ownerContext.close();
  await memberContext.close();
});

test('signing out hides team threads', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await teamPage(context);
  await signIn(page, { email: 'olivia@example.com', password: 'correct horse battery' });
  await expect(page.getByRole('button', { name: /^Thread by Olivia/ })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Thread by Olivia/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Thread by Olivia/ })).toHaveCount(0);
  await context.close();
});

test('a coding agent answers a thread over MCP, and the overlay shows it as the agent', async ({ browser, request }) => {
  const context = await browser.newContext();
  const admin = await context.newPage();
  await admin.goto(`${SYNC_URL}/login`);
  await admin.getByLabel('Email').fill('olivia@example.com');
  await admin.getByLabel('Password').fill('correct horse battery');
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await admin.getByLabel('Agent name').fill('Claude Code');
  await admin.getByRole('button', { name: 'Create a token' }).click();
  const command = (await admin.locator('.ok pre').textContent())!;
  expect(command).toContain(`claude mcp add --transport http openparley ${SYNC_URL}/mcp`);
  const token = /Bearer (opa_[\w-]+)/.exec(command)![1]!;

  const call = async (name: string, args: unknown) => {
    const res = await request.post(`${SYNC_URL}/mcp`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    return (await res.json()).result.structuredContent;
  };
  const { threads } = await call('list_threads', {});
  const thread = threads.find((t: { request: { body: string } }) => t.request.body.includes('Start free trial'));
  expect(thread.element).toMatchObject({ selector: '#cta', tag: 'button' });
  await call('reply_to_thread', { id: thread.id, body: 'Changed the button label in team.html' });

  const page = await teamPage(context);
  await signIn(page);
  await page.getByRole('button', { name: /^Thread by Olivia: Should say/ }).click();
  const card = page.getByRole('dialog', { name: 'Thread' });
  await expect(card.getByText('Changed the button label in team.html')).toBeVisible();
  await expect(card.getByText('agent · Olivia')).toBeVisible();

  await admin.goto(`${SYNC_URL}/admin`);
  await expect(admin.getByText(/last used \d{4}-\d{2}-\d{2}/)).toBeVisible();
  await context.close();
});

test('an agent signs in with OAuth: sign in, approve, and the code it gets back works over MCP', async ({ page, request }) => {
  const callback = `${SITE_URL}/oauth-callback`;
  const client = await (await request.post(`${SYNC_URL}/oauth/register`, { data: { client_name: 'Cursor', redirect_uris: [callback], token_endpoint_auth_method: 'none' } })).json();
  const verifier = 'e2e-verifier-'.padEnd(64, 'x');
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: callback,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'e2e-state',
    resource: `${SYNC_URL}/mcp`,
  });

  await page.goto(`${SYNC_URL}/oauth/authorize?${params}`);
  await page.getByLabel('Email').fill('olivia@example.com');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Connect an agent?' })).toBeVisible();
  await expect(page.getByText('an app on this computer (localhost:4173)')).toBeVisible();
  // Repeated runs share the server, and every run registers a new client: the name tells them apart.
  const agentName = `Cursor ${test.info().repeatEachIndex}-${Date.now() % 100000}`;
  await page.getByLabel('Agent name').fill(agentName);
  await page.getByRole('button', { name: 'Approve' }).click();

  // A plain 302 here would be blocked by the consent page's form-action CSP; this checks the real browser gets through.
  await page.waitForURL((url) => url.href.startsWith(`${callback}?`));
  const back = new URL(page.url());
  expect(back.searchParams.get('state')).toBe('e2e-state');
  const tokens = await (
    await request.post(`${SYNC_URL}/oauth/token`, {
      form: { grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: client.client_id, redirect_uri: callback, code_verifier: verifier },
    })
  ).json();
  const res = await request.post(`${SYNC_URL}/mcp`, {
    headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_threads', arguments: {} } },
  });
  expect((await res.json()).result.isError).toBeFalsy();

  await page.goto(`${SYNC_URL}/admin`);
  await expect(page.getByRole('row', { name: agentName })).toContainText(/signed in \d{4}-\d{2}-\d{2}/);
});

test('threads stay in the environment they were made in; other environments are one click away', async ({ browser }) => {
  // Two origins of one project: localhost and 127.0.0.1 serve the same fixture.
  const other = SITE_URL.replace('localhost', '127.0.0.1');
  const admin = await request.newContext({ baseURL: SYNC_URL, extraHTTPHeaders: { origin: SYNC_URL } });
  await admin.post('/login', { form: { email: 'olivia@example.com', password: 'correct horse battery' } });
  await admin.post('/admin/projects', { form: { name: 'Environments', origins: `${SITE_URL}\n${other}` } });
  const project = [...(await (await admin.get('/admin')).text()).matchAll(/data-project=(?:&quot;|")([\w-]+)/g)].at(-1)![1]!;
  await admin.dispose();

  const context = await browser.newContext();
  const open = async (origin: string, query = '') => {
    const page = await context.newPage();
    await page.goto(`${origin}/team.html?project=${project}${query}`);
    await page.getByRole('button', { name: /^Show threads/ }).click();
    return page;
  };
  const post = async (page: Page, body: string) => {
    await page.keyboard.press('c');
    await page.locator('#cta').click();
    await page.getByRole('dialog', { name: 'New thread' }).getByRole('textbox').fill(body);
    await page.getByRole('dialog', { name: 'New thread' }).getByRole('button', { name: 'Post' }).click();
    await expect(page.getByRole('dialog', { name: 'Thread' }).getByText(body)).toBeVisible();
    await page.keyboard.press('Escape');
  };

  const local = await open(SITE_URL);
  await signIn(local, { email: 'olivia@example.com', password: 'correct horse battery' });
  await post(local, 'Seen on localhost');

  const second = await open(other);
  await signIn(second);
  await expect(second.getByRole('button', { name: /^Thread by Olivia/ })).toHaveCount(0);
  await second.getByRole('button', { name: /^List threads/ }).click();
  const list = second.getByRole('dialog', { name: 'Threads' });
  await expect(list.getByText('No threads in this environment yet.')).toBeVisible();
  await expect(list.getByText('Other environments')).toBeVisible();
  await list.getByRole('button', { name: /Seen on localhost/ }).click();
  const card = second.getByRole('dialog', { name: 'Thread' });
  await expect(card.getByText('Made on localhost:4173.')).toBeVisible();
  // Opened from elsewhere, it still lands on its element.
  await expect(second.getByRole('button', { name: /^Thread by Olivia/ })).toHaveCount(1);
  await second.keyboard.press('Escape');
  await expect(second.getByRole('button', { name: /^Thread by Olivia/ })).toHaveCount(0);

  // A shared label joins both origins.
  const labelled = await open(other, '&environment=preview&revision=a1b2c3d');
  await post(labelled, 'On the preview');
  const labelledLocal = await open(SITE_URL, '&environment=preview');
  await expect(labelledLocal.getByRole('button', { name: /^Thread by Olivia: On the preview/ })).toBeVisible();
  await expect(labelledLocal.getByRole('button', { name: /^Thread by Olivia: Seen on localhost/ })).toHaveCount(0);
  await context.close();
});

test('a team link to a thread on another page goes there and opens it', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${SITE_URL}/team.html?tab=specs&project=${projectId}`);
  await page.getByRole('button', { name: /^Show threads/ }).click();
  await signIn(page, { email: 'olivia@example.com', password: 'correct horse battery' });
  await page.keyboard.press('c');
  await page.locator('#cta').click();
  await page.getByRole('dialog', { name: 'New thread' }).getByRole('textbox').fill('Specs tab only');
  await page.getByRole('dialog', { name: 'New thread' }).getByRole('button', { name: 'Post' }).click();
  const card = page.getByRole('dialog', { name: 'Thread' });
  await expect(card.getByText('Specs tab only')).toBeVisible();

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await card.getByRole('button', { name: 'Copy link to this thread' }).click();
  const link = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  // The link points at the page the thread was made on, query sorted.
  expect(link.search).toBe(`?project=${projectId}&tab=specs`);

  const other = await context.newPage();
  await other.goto(`${SITE_URL}/team.html?project=${projectId}${link.hash}`);
  await expect(other).toHaveURL(`${SITE_URL}/team.html?project=${projectId}&tab=specs`);
  await expect(other.getByRole('dialog', { name: 'Thread' }).getByText('Specs tab only')).toBeVisible();
  await context.close();
});

test('an admin adds a new site from the sign-in window in one click', async ({ browser }) => {
  const other = SITE_URL.replace('localhost', '127.0.0.1');
  const admin = await request.newContext({ baseURL: SYNC_URL, extraHTTPHeaders: { origin: SYNC_URL } });
  await admin.post('/login', { form: { email: 'olivia@example.com', password: 'correct horse battery' } });
  await admin.post('/admin/projects', { form: { name: 'One click', origins: SITE_URL } });
  const project = [...(await (await admin.get('/admin')).text()).matchAll(/data-project=(?:&quot;|")([\w-]+)/g)].at(-1)![1]!;
  await admin.dispose();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${other}/team.html?project=${project}`);
  await page.getByRole('button', { name: /^Show threads/ }).click();
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const popup = await popupPromise;
  await popup.getByLabel('Email').fill('olivia@example.com');
  await popup.getByLabel('Password').fill('correct horse battery');
  await popup.getByRole('button', { name: 'Sign in' }).click();
  await expect(popup.getByRole('heading', { name: 'Add this site?' })).toBeVisible();
  await popup.getByRole('button', { name: `Add ${other}` }).click();
  await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);
  await expect(page.getByRole('toolbar', { name: 'OpenParley' }).getByRole('button', { name: 'Comment' })).toBeVisible();
  await context.close();
});

test.describe('launcher="members" on a production site', () => {
  const url = () => `${SITE_URL}/team.html?project=${projectId}&launcher=members`;
  const owner = { email: 'olivia@example.com', password: 'correct horse battery' };

  function appRequests(page: Page): string[] {
    const urls: string[] = [];
    page.on('request', (request) => {
      if (/\/openparley-app-\w+\.js$/.test(request.url())) urls.push(request.url());
    });
    return urls;
  }

  test('ordinary visitors only download the tiny loader', async ({ page }) => {
    const app = appRequests(page);
    const loader = page.waitForRequest(`${SYNC_URL}/openparley.js`);
    await page.goto(url());
    await loader;
    await page.waitForLoadState('networkidle');
    expect(app).toEqual([]);
    await expect(page.locator('openparley-overlay')).toHaveCount(0);
  });

  test('a teammate switches it on once; it then loads on every visit until they sign out', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${url()}#openparley`);
    await expect(page.getByRole('toolbar', { name: 'OpenParley' }).getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    await signIn(page, owner);

    await page.goto(url());
    await expect(page.getByRole('toolbar', { name: 'OpenParley' }).getByRole('button', { name: 'Comment' })).toBeVisible();

    // An expired session still shows teammates the overlay, with a way back in.
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith('openparley:v1:token:')) localStorage.removeItem(key);
    });
    await page.reload();
    await signIn(page);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    const app = appRequests(page);
    await page.reload();
    await page.waitForLoadState('networkidle');
    expect(app).toEqual([]);
    await expect(page.locator('openparley-overlay')).toHaveCount(0);
    await context.close();
  });

  test('a team thread link works in a browser that is not a member yet', async ({ browser }) => {
    const ownerContext = await browser.newContext();
    await ownerContext.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await ownerContext.newPage();
    await page.goto(`${url()}#openparley`);
    await signIn(page, owner);
    await page.keyboard.press('c');
    await page.locator('#intro').click();
    await page.getByRole('dialog', { name: 'New thread' }).getByRole('textbox').fill('Intro copy needs work');
    await page.getByRole('dialog', { name: 'New thread' }).getByRole('button', { name: 'Post' }).click();
    await page.getByRole('button', { name: 'Copy link to this thread' }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());

    const newcomer = await (await browser.newContext()).newPage();
    await newcomer.goto(link);
    await expect(newcomer.getByRole('toolbar', { name: 'OpenParley' }).getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(newcomer.getByText('Sign in to see the thread that was shared with you.')).toBeVisible();
    await signIn(newcomer, owner);
    await expect(newcomer.getByRole('dialog', { name: 'Thread' }).getByText('Intro copy needs work')).toBeVisible();
    await ownerContext.close();
  });
});
