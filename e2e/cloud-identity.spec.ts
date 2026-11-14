import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { CLOUD_PORT } from './playwright.config';

const control = `http://cloud.localhost:${CLOUD_PORT}`;
const mcpUrl = `http://mcp.localhost:${CLOUD_PORT}/mcp`;
const AGENT_CALLBACK = 'http://127.0.0.1:33418/callback';
const VERIFIER = 'e2e-agent-verifier-'.padEnd(64, 'x');

test('sign up with GitHub, then an agent connects through the one MCP URL and works', async ({ page, request }) => {
  // Sign-up: GitHub first. The fake GitHub lets us pick who we are.
  await page.goto(`${control}/signup?plan=free`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await page.getByRole('link', { name: 'olivia-dev' }).click();

  // Back on Cloud, signed in: no email field, the name starts as the GitHub username.
  await expect(page.getByText('Signed in as')).toBeVisible();
  await expect(page.getByLabel('Your email')).toHaveCount(0);
  const name = `Acme ${Date.now().toString(36)}`;
  await page.getByLabel('Company or project name').fill(name);
  const slug = name.toLowerCase().replace(' ', '-');
  await expect(page.locator('#address')).toHaveText(slug);
  await page.getByRole('button', { name: 'Create workspace' }).click();

  // The workspace exists right away and we're its owner there, without a password.
  const workspace = `http://${slug}.localhost:${CLOUD_PORT}`;
  await expect(page).toHaveURL(`${workspace}/admin`);
  await expect(page.getByText('Olivia · owner')).toBeVisible();
  await expect(page.getByText(`claude mcp add --transport http openparley ${mcpUrl}`)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add to Cursor' })).toHaveAttribute('href', /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?/);

  // An agent registers with the shared URL's sign-in server and sends the browser to sign in.
  const registered = await (await request.post(`${control}/oauth/register`, { data: { client_name: 'Claude Code', redirect_uris: [AGENT_CALLBACK] } })).json();
  const challenge = createHash('sha256').update(VERIFIER).digest('base64url');
  await page.goto(
    `${control}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: AGENT_CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', resource: mcpUrl })}`,
  );
  // One workspace goes straight to its consent page; with more (other tests sign up as olivia-dev too) we pick it.
  await page.waitForLoadState();
  if (page.url().startsWith(`${control}/oauth/authorize`)) {
    await page.getByRole('radio', { name: new RegExp(name) }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page).toHaveURL(new RegExp(`^${workspace}/oauth/authorize`));
  await expect(page.getByRole('heading', { name: 'Connect an agent?' })).toBeVisible();
  // Cloud sends the browser on to the agent's own callback (nothing listens there in this test).
  const handedBack = page.waitForResponse((r) => r.url().startsWith(`${control}/oauth/workspace-callback`));
  await page.getByRole('button', { name: 'Approve' }).click();
  const callback = new URL((await handedBack).headers()['location']!);
  expect(callback.origin + callback.pathname).toBe(AGENT_CALLBACK);
  expect(callback.searchParams.get('state')).toBe('s1');

  const tokens = await (
    await request.post(`${control}/oauth/token`, {
      form: { grant_type: 'authorization_code', code: callback.searchParams.get('code')!, code_verifier: VERIFIER, client_id: registered.client_id, redirect_uri: AGENT_CALLBACK },
    })
  ).json();
  const res = await request.post(mcpUrl, {
    headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(res.status()).toBe(200);
  expect(JSON.stringify(await res.json())).toContain('list_threads');

  // The agent is listed in the workspace like any other.
  // (A new tab: the first one is still failing to reach the agent's callback.)
  const admin = await page.context().newPage();
  await admin.goto(`${workspace}/admin`);
  await expect(admin.getByText('Claude Code', { exact: true })).toBeVisible();
});
