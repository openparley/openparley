import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CLOUD_DATA, CLOUD_PORT, FAKE_POLAR_URL, SITE_URL } from './playwright.config';

const cli = (...args: string[]) =>
  execFileSync('bun', [fileURLToPath(new URL('../ee/cloud/src/cli.ts', import.meta.url)), ...args], {
    env: { ...process.env, CLOUD_DOMAIN: 'localhost', DATA_DIR: CLOUD_DATA, PORT: String(CLOUD_PORT) },
    encoding: 'utf8',
  });

test('a provisioned cloud workspace works end to end, and can be paused', async ({ browser }) => {
  const slug = `acme${Date.now().toString(36)}`;
  const workspace = `http://${slug}.localhost:${CLOUD_PORT}`;
  const setupUrl = /(http:\/\/\S+\/setup\?token=\S+)/.exec(cli('create', slug, 'Acme Inc', '--members', '5'))![1]!;
  expect(setupUrl.startsWith(`${workspace}/setup`)).toBe(true);

  // The owner follows the setup link, creates a project for their site.
  const context = await browser.newContext();
  const admin = await context.newPage();
  await admin.goto(setupUrl);
  await admin.getByLabel('Name').fill('Olivia');
  await admin.getByLabel('Email').fill('olivia@acme.test');
  await admin.getByLabel('Password').fill('correct horse battery');
  await admin.getByRole('button', { name: 'Create owner account' }).click();
  await expect(admin).toHaveURL(`${workspace}/admin`);
  await expect(admin.getByText('1 of 5 seats used')).toBeVisible();
  await admin.getByLabel('Name', { exact: true }).fill('Website');
  await admin.getByLabel('Allowed sites (one per line)').fill(SITE_URL);
  await admin.getByRole('button', { name: 'Create project' }).click();
  const project = /data-project="([\w-]+)"/.exec((await admin.locator('pre').first().textContent())!)![1]!;

  // On their website, the overlay talks to the cloud workspace.
  const site = await context.newPage();
  await site.goto(`${SITE_URL}/team.html?project=${project}&server=${encodeURIComponent(workspace)}`);
  await site.getByRole('button', { name: /^Show threads/ }).click();
  const popupPromise = site.waitForEvent('popup');
  await site.getByRole('button', { name: 'Sign in' }).click();
  const popup = await popupPromise;
  await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);
  await site.keyboard.press('c');
  await site.locator('#cta').click();
  await site.getByRole('dialog', { name: 'New thread' }).getByRole('textbox').fill('Hosted on Cloud');
  await site.getByRole('dialog', { name: 'New thread' }).getByRole('button', { name: 'Post' }).click();
  await expect(site.getByRole('dialog', { name: 'Thread' }).getByText('Olivia', { exact: true })).toBeVisible();

  // Pausing the workspace takes effect on the next request: people land on its page on the control plane.
  cli('suspend', slug);
  await admin.goto(`${workspace}/admin`);
  await expect(admin).toHaveURL(`http://cloud.localhost:${CLOUD_PORT}/workspaces/${slug}`);
  await expect(admin.getByRole('heading', { name: 'Acme Inc is paused' })).toBeVisible();
  // Without a billing contact there is nothing to renew; the overlay's API calls get a plain 402.
  await expect(admin.getByRole('button', { name: /renewal link/ })).toHaveCount(0);
  expect((await admin.request.get(`${workspace}/api/me`)).status()).toBe(402);
  cli('resume', slug);
  await admin.goto(`${workspace}/admin`);
  await expect(admin.getByLabel('Name', { exact: true }).first()).toHaveValue('Website');
  await context.close();
});

test('self-serve sign-up: checkout, setup link, owner account; a revoked subscription drops it to Free; the billing contact upgrades again', async ({ page, request }) => {
  const control = `http://cloud.localhost:${CLOUD_PORT}`;
  const email = `owner-${Date.now().toString(36)}@globex.test`;
  await page.goto(control);
  await page.getByRole('link', { name: 'Start with Team', exact: true }).click();

  // The address follows the name until it's edited by hand.
  await page.getByLabel('Workspace name').fill('Globex Corp');
  await expect(page.getByLabel('Address')).toHaveValue('globex-corp');
  const slug = `globex${Date.now().toString(36)}`;
  await page.getByLabel('Address').fill(slug);
  await page.getByLabel('Your email').fill(email);
  await expect(page.getByRole('radio', { name: /^Team/ })).toBeChecked();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL(new RegExp(`^${FAKE_POLAR_URL}/checkout/`));
  await page.getByRole('button', { name: 'Pay' }).click();

  // Back on Cloud; the page refreshes itself until the webhook has provisioned the workspace.
  await expect(page).toHaveURL(new RegExp(`^${control}/signup/done`));
  await expect(page.getByRole('heading', { name: 'Your workspace is ready' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Create your owner account' }).click();

  const workspace = `http://${slug}.localhost:${CLOUD_PORT}`;
  await expect(page).toHaveURL(new RegExp(`^${workspace}/setup`));
  await page.getByLabel('Name').fill('Grace');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page).toHaveURL(`${workspace}/admin`);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();

  // The subscription ends (Polar revokes it): the workspace keeps working on the Free plan.
  const [subscription] = await (await request.get(`${FAKE_POLAR_URL}/test/subscriptions?email=${encodeURIComponent(email)}`)).json();
  await request.post(`${FAKE_POLAR_URL}/test/subscriptions/${subscription.id}`, { data: { status: 'canceled' } });
  await expect(async () => {
    await page.goto(`${workspace}/admin`);
    await expect(page.getByText('1 of 1 seats used')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Add more seats' }).click();
  await expect(page.getByRole('heading', { name: 'Globex Corp is on the free plan' })).toBeVisible();
  await expect(page.getByText('Team subscription has ended')).toBeVisible();
  await page.getByRole('button', { name: /^Email an upgrade link to o•••@globex\.test$/ }).click();
  await expect(page.getByRole('status')).toContainText('emailed a link');

  // The link from that email (here from the operator CLI, since mail goes to the server log).
  const link = /(http:\/\/cloud\.localhost\S+\/renew\?token=\S+)/.exec(cli('upgrade-link', slug))![1]!;
  await page.goto(link);
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await expect(page).toHaveURL(new RegExp(`^${FAKE_POLAR_URL}/checkout/`));
  await page.getByRole('button', { name: 'Pay' }).click();

  await expect(page.getByRole('heading', { name: 'Globex Corp is active' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: workspace }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
});

test('free plan: one person; inviting someone means upgrading to Team, with a trial', async ({ browser }) => {
  const control = `http://cloud.localhost:${CLOUD_PORT}`;
  const slug = `initech${Date.now().toString(36)}`;
  const workspace = `http://${slug}.localhost:${CLOUD_PORT}`;
  const email = `${slug}@initech.test`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(control);
  await page.getByRole('link', { name: 'Start for free' }).click();
  await page.getByLabel('Workspace name').fill('Initech');
  await page.getByLabel('Address').fill(slug);
  await page.getByLabel('Your email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  // The confirmation link (mail goes to the server log, so it comes from the operator CLI).
  await page.goto(/(http:\/\/cloud\.localhost\S+\/signup\/confirm\?signup=\S+)/.exec(cli('signup-link', slug))![1]!);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(new RegExp(`^${workspace}/setup`));
  await page.getByLabel('Name').fill('Peter');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByText('1 of 1 seats used')).toBeVisible();

  // Free is for one person: an invite is refused and points to the upgrade.
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('allows up to 1 member');
  await page.getByRole('link', { name: 'Add more seats' }).click();
  await expect(page.getByRole('heading', { name: 'Initech is on the free plan' })).toBeVisible();
  await expect(page.getByText('free for 31 days, then $19/month')).toBeVisible();
  await page.getByRole('button', { name: /^Email an upgrade link/ }).click();
  await expect(page.getByRole('status')).toContainText('emailed a link');
  await page.goto(/(http:\/\/cloud\.localhost\S+\/renew\?token=\S+)/.exec(cli('upgrade-link', slug))![1]!);
  await expect(page.getByRole('heading', { name: 'Upgrade Initech' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await expect(page).toHaveURL(new RegExp(`^${FAKE_POLAR_URL}/checkout/`));
  await page.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByRole('heading', { name: 'Initech is active' })).toBeVisible({ timeout: 15_000 });

  // On Team the same invite works.
  await page.goto(`${workspace}/admin`);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(page.getByText('Invite link created.')).toBeVisible();
  await context.close();
});
