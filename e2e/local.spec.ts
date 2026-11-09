import { expect, test, type Page } from '@playwright/test';

async function openOverlay(page: Page) {
  await page.getByRole('button', { name: /^Show threads/ }).click();
  await expect(page.getByRole('toolbar', { name: 'OpenParley' })).toBeVisible();
}

async function createThread(page: Page, target: string, body: string, name?: string) {
  await page.getByRole('toolbar', { name: 'OpenParley' }).getByRole('button', { name: 'Comment' }).click();
  await page.locator(target).first().click();
  const dialog = page.getByRole('dialog', { name: 'New thread' });
  if (name) await dialog.getByLabel('Your name').fill(name);
  await dialog.getByRole('textbox', { name: /on your mind/ }).fill(body);
  await dialog.getByRole('button', { name: 'Post' }).click();
  await expect(page.getByRole('dialog', { name: 'Thread' }).getByText(body)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('create a thread, see it after reload', async ({ page }) => {
  await openOverlay(page);
  await createThread(page, '.product h3', 'Title should mention the paper weight', 'Ada');
  await page.keyboard.press('Escape');

  const pin = page.getByRole('button', { name: /^Thread by Ada/ });
  await expect(pin).toHaveText('1');

  await page.reload();
  // The overlay remembers it was open during this browser session.
  await expect(page.getByRole('button', { name: 'List threads on this page (1 open thread)' })).toBeVisible();
  await expect(pin).toBeVisible();
  await pin.click();
  const card = page.getByRole('dialog', { name: 'Thread' });
  await expect(card.getByText('Title should mention the paper weight')).toBeVisible();
  await expect(card.getByText('Ada', { exact: true })).toBeVisible();
});

test('picking an element does not trigger the page', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__clicks = 0;
    document.querySelector('[data-testid="add-to-cart"]')!.addEventListener('click', () => (window as any).__clicks++);
  });
  await openOverlay(page);
  await page.keyboard.press('c');
  await expect(page.getByText('Click an element to start a thread')).toBeVisible();
  await page.locator('[data-testid="add-to-cart"]').click();
  await expect(page.getByRole('dialog', { name: 'New thread' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__clicks)).toBe(0);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'New thread' })).toBeHidden();
  await page.locator('[data-testid="add-to-cart"]').click();
  expect(await page.evaluate(() => (window as any).__clicks)).toBe(1);
});

test('reply, resolve and reopen', async ({ page }) => {
  await openOverlay(page);
  await createThread(page, '.price', 'Is the discount still running?', 'Ada');
  const card = page.getByRole('dialog', { name: 'Thread' });
  await card.getByRole('textbox', { name: 'Reply' }).fill('Until Sunday');
  await card.getByRole('textbox', { name: 'Reply' }).press('ControlOrMeta+Enter');
  await expect(card.getByText('Until Sunday')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Thread by Ada/ })).toHaveText('2');

  await card.getByRole('button', { name: 'Resolve thread' }).click();
  await expect(card.getByText('Resolved', { exact: true })).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(card).toBeHidden();
  // Resolved threads are hidden unless asked for.
  await expect(page.getByRole('button', { name: /^Resolved thread by Ada/ })).toBeHidden();
  await page.getByRole('button', { name: /^List threads on this page/ }).click();
  await page.getByLabel(/Show resolved/).check();
  await page.getByRole('listitem').getByRole('button', { name: /Is the discount still running/ }).click();
  await card.getByRole('button', { name: 'Reopen thread' }).click();
  await expect(card.getByText('Open', { exact: true })).toBeVisible();
});

test('a copied link opens the conversation in another browser', async ({ page, browser, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openOverlay(page);
  await createThread(page, '[data-testid="add-to-cart"]', 'Button label is too generic 🛒', 'Ada');
  await page.getByRole('button', { name: 'Copy link to this thread' }).click();
  await expect(page.getByText('Link copied')).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain('#parley=z1.');

  const other = await browser.newContext();
  const visitor = await other.newPage();
  await visitor.goto(link);
  const card = visitor.getByRole('dialog', { name: 'Thread' });
  await expect(card.getByText('Button label is too generic 🛒')).toBeVisible();
  await expect(card.getByText(/element .* isn't on the page/)).toHaveCount(0);
  await expect(visitor.locator('.spotlight')).toBeVisible();
  // The link is consumed so reloading or bookmarking doesn't re-import it.
  await expect.poll(() => new URL(visitor.url()).hash).toBe('');

  // The visitor replies (asked for a name first) and the reply sticks locally.
  await card.getByLabel('Your name').fill('Bo');
  await card.getByRole('textbox', { name: 'Reply' }).fill('Agreed, "Add notebook to cart"?');
  await card.getByRole('button', { name: 'Reply' }).click();
  await expect(card.getByText('Agreed, "Add notebook to cart"?')).toBeVisible();
  await other.close();
});

test('threads whose element disappeared are listed, not misplaced', async ({ page }) => {
  await openOverlay(page);
  await createThread(page, '#postcode', 'Validate Dutch postcodes', 'Ada');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('#postcode')!.remove());
  await expect(page.getByRole('button', { name: /^Thread by Ada/ })).toBeHidden();
  await page.getByRole('button', { name: /^List threads on this page/ }).click();
  await expect(page.getByText('element not found')).toBeVisible();
  await page.getByRole('listitem').getByRole('button', { name: /Validate Dutch postcodes/ }).click();
  await expect(page.getByText("The element this thread was attached to isn't on the page anymore.")).toBeVisible();
});

test('client-side navigation switches the page’s threads', async ({ page }) => {
  await openOverlay(page);
  await createThread(page, '.product h3', 'Home page thread', 'Ada');
  await page.keyboard.press('Escape');
  await page.evaluate(() => history.pushState(null, '', '/some/other/page'));
  await expect(page.getByRole('button', { name: /^Thread by Ada/ })).toBeHidden();
  await page.evaluate(() => history.back());
  await expect(page.getByRole('button', { name: /^Thread by Ada/ })).toBeVisible();
});

test('pins follow their element while scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await openOverlay(page);
  await createThread(page, '#postcode', 'Scroll check', 'Ada');
  await page.keyboard.press('Escape');
  const pin = page.getByRole('button', { name: /^Thread by Ada/ });
  const offset = async () => {
    const [p, t] = await Promise.all([pin.boundingBox(), page.locator('#postcode').boundingBox()]);
    return { dx: Math.round(p!.x - t!.x), dy: Math.round(p!.y - t!.y) };
  };
  const before = await offset();
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(150);
  expect(await offset()).toEqual(before);
});

test('host page styles do not leak into the overlay', async ({ page }) => {
  await page.addStyleTag({ content: 'button { background: red !important; font-size: 40px !important; } * { color: lime !important; }' });
  await openOverlay(page);
  const color = await page
    .getByRole('toolbar', { name: 'OpenParley' })
    .getByRole('button', { name: 'Comment' })
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(color).not.toBe('40px');
});

test('a closed overlay shows how many threads are open', async ({ page }) => {
  await openOverlay(page);
  await createThread(page, '.product h3', 'Counting', 'Ada');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Show threads (1 open thread on this page)' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Thread by Ada/ })).toBeHidden();
});

test('the thread card never covers its own pin', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOverlay(page);
  await createThread(page, '.price', 'Overlap check', 'Ada');
  const pin = (await page.getByRole('button', { name: /^Thread by Ada/ }).boundingBox())!;
  const card = (await page.getByRole('dialog', { name: 'Thread' }).boundingBox())!;
  const overlaps = pin.x < card.x + card.width && pin.x + pin.width > card.x && pin.y < card.y + card.height && pin.y + pin.height > card.y;
  expect(overlaps).toBe(false);
});

test('launcher="auto" stays hidden until switched on, and remembers', async ({ page }) => {
  const overlay = page.locator('openparley-overlay');
  const toolbar = page.getByRole('toolbar', { name: 'OpenParley' });
  const appRequests: string[] = [];
  page.on('request', (request) => {
    if (/openparley-app-/.test(request.url())) appRequests.push(request.url());
  });

  await page.goto('/auto.html');
  await page.waitForLoadState('networkidle');
  await expect(overlay).toHaveCount(0);
  expect(appRequests).toEqual([]);

  // Asking for it opens the toolbar straight away and cleans the address bar.
  await page.goto('/auto.html#openparley');
  await expect(toolbar).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await page.goto('/auto.html');
  await expect(toolbar).toBeVisible();

  await page.goto('/auto.html#openparley=off');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(overlay).toHaveCount(0);

  // Switching on via the hash also works without a reload.
  await page.evaluate(() => (location.hash = 'openparley'));
  await expect(toolbar).toBeVisible();
});

test('pins stay put when hovered or selected, so they can be clicked', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOverlay(page);
  await createThread(page, '#postcode', 'Hover check', 'Ada');
  await page.keyboard.press('Escape');
  const pin = page.getByRole('button', { name: /^Thread by Ada/ });
  const center = async () => {
    const box = (await pin.boundingBox())!;
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };
  const resting = await center();

  // Hover like a person would: move there, then wait longer than the hover transition.
  await page.mouse.move(resting.x, resting.y);
  await page.waitForTimeout(400);
  expect(await center()).toEqual(resting);
  const underPointer = await page.evaluate(({ x, y }) => {
    const host = document.querySelector('openparley-overlay')!;
    return host.shadowRoot!.elementFromPoint(x, y)?.className;
  }, resting);
  expect(underPointer).toBe('pin');

  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole('dialog', { name: 'Thread' })).toBeVisible();
  await page.waitForTimeout(400);
  expect(await center()).toEqual(resting);
});

type Rect = { x: number; y: number; width: number; height: number };
const encloses = (outer: Rect, inner: Rect) =>
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('an open thread spotlights its element without blocking the page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOverlay(page);
  const target = page.locator('[data-testid="add-to-cart"]');
  const spotlight = page.locator('.spotlight');
  await createThread(page, '[data-testid="add-to-cart"]', 'Spotlight check', 'Ada');
  await expect(spotlight).toBeVisible();
  expect(encloses((await spotlight.boundingBox())!, (await target.boundingBox())!)).toBe(true);
  expect(overlaps((await page.getByRole('dialog', { name: 'Thread' }).boundingBox())!, (await target.boundingBox())!)).toBe(false);

  await page.keyboard.press('Escape');
  await expect(spotlight).toHaveCount(0);
  await page.getByRole('button', { name: /^Thread by Ada/ }).click();
  await expect(spotlight).toBeVisible();

  // The dimmed page still takes clicks: this closes the thread and focuses the field.
  await page.locator('#postcode').click();
  await expect(page.getByRole('dialog', { name: 'Thread' })).toBeHidden();
  await expect(spotlight).toHaveCount(0);
  await expect(page.locator('#postcode')).toBeFocused();
});

test('pick mode spotlights the element under the pointer', async ({ page }) => {
  await openOverlay(page);
  await page.keyboard.press('c');
  const spotlight = page.locator('.spotlight');
  await page.locator('.price').hover();
  await expect(spotlight).toContainText('div.price');
  await expect.poll(async () => encloses((await spotlight.boundingBox())!, (await page.locator('.price').boundingBox())!)).toBe(true);
  await page.locator('#postcode').hover();
  await expect(spotlight).toContainText('input#postcode');
  await expect.poll(async () => encloses((await spotlight.boundingBox())!, (await page.locator('#postcode').boundingBox())!)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(spotlight).toHaveCount(0);
});

test('the thread card sits beside small elements instead of on them', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOverlay(page);
  for (const [i, target] of ['#postcode', '.price', '.product h3'].entries()) {
    await createThread(page, target, `Placement ${target}`, i === 0 ? 'Ada' : undefined);
    const card = (await page.getByRole('dialog', { name: 'Thread' }).boundingBox())!;
    expect(overlaps(card, (await page.locator(target).first().boundingBox())!), target).toBe(false);
    await page.keyboard.press('Escape');
  }
});

test('the new thread form takes focus, and clicking away closes it', async ({ page }) => {
  await openOverlay(page);
  await page.keyboard.press('c');
  await page.locator('.price').click();
  const dialog = page.getByRole('dialog', { name: 'New thread' });
  // First time in this browser: the name comes first, Enter moves on to the comment.
  await expect(dialog.getByLabel('Your name')).toBeFocused();
  await page.keyboard.type('Ada');
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('textbox', { name: /on your mind/ })).toBeFocused();
  await page.keyboard.type('First');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('dialog', { name: 'Thread' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Once the name is known, typing can start straight away.
  await page.keyboard.press('c');
  await page.locator('#postcode').click();
  await expect(dialog.getByRole('textbox', { name: /on your mind/ })).toBeFocused();
  await page.keyboard.type('Unsent draft');
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await expect(page.locator('.spotlight')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Unsent draft/ })).toHaveCount(0);
});

test('Esc in the reply box closes the thread', async ({ page }) => {
  await openOverlay(page);
  await createThread(page, '.price', 'Esc check', 'Ada');
  const card = page.getByRole('dialog', { name: 'Thread' });
  await card.getByRole('textbox', { name: 'Reply' }).click();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'OpenParley' })).toBeVisible();
});

test('actions show their keyboard shortcut', async ({ page }) => {
  await openOverlay(page);
  const toolbar = page.getByRole('toolbar', { name: 'OpenParley' });
  await expect(toolbar.getByRole('button', { name: 'Comment' })).toHaveAttribute('aria-keyshortcuts', 'C');
  await expect(toolbar.getByRole('button', { name: 'Comment' })).toHaveAttribute('title', 'Comment (C)');
  await expect(toolbar.getByRole('button', { name: 'Comment' }).locator('kbd')).toHaveText('C');
  await expect(toolbar.getByRole('button', { name: /^List threads/ })).toContainText('View all');
  await page.keyboard.press('c');
  await expect(toolbar.getByRole('button', { name: 'Cancel' }).locator('kbd')).toHaveText('Esc');
  await page.locator('.price').click();
  const dialog = page.getByRole('dialog', { name: 'New thread' });
  await expect(dialog.getByRole('button', { name: 'Cancel' }).locator('kbd')).toHaveText('Esc');
  await expect(dialog.getByRole('button', { name: 'Post' }).locator('kbd')).toHaveText(/^(⌘↵|Ctrl ↵)$/);
  await expect(dialog.getByRole('button', { name: 'Post' })).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter');
});

test('while placing a thread the cursor is a pin that keeps following the pointer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOverlay(page);
  const cursorOf = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).cursor);
  const before = await cursorOf('.price');
  const pin = page.locator('.pin[data-cursor]');

  await page.keyboard.press('c');
  await expect.poll(() => cursorOf('.price')).toBe('none');
  // Many moves across different elements: the pin's tip must stay exactly on the pointer.
  const points: [number, number][] = [[300, 420], [880, 500], [420, 300], [900, 560], [250, 700], [600, 200]];
  for (const [x, y] of points) {
    await page.mouse.move(x, y, { steps: 4 });
    await expect(pin).toBeVisible();
    await expect.poll(async () => {
      const box = (await pin.boundingBox())!;
      return [Math.round(box.x), Math.round(box.y + box.height)];
    }).toEqual([x, y]);
  }

  // Over OpenParley's own toolbar the normal cursor is back and the pin steps aside.
  const cancel = page.getByRole('toolbar', { name: 'OpenParley' }).getByRole('button', { name: 'Cancel' });
  await cancel.hover();
  await expect(pin).toBeHidden();
  expect(await cancel.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
  await page.mouse.move(500, 400, { steps: 4 });
  await expect(pin).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(pin).toHaveCount(0);
  await expect.poll(() => cursorOf('.price')).toBe(before);
});

test('J and K step through threads in reading order, also with the card arrows', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOverlay(page);
  // Created out of page order on purpose: stepping follows the page, not creation time.
  await createThread(page, '.price', 'Middle', 'Ada');
  await page.keyboard.press('Escape');
  await createThread(page, '[data-testid="add-to-cart"]', 'Bottom');
  await page.keyboard.press('Escape');
  await createThread(page, '.art', 'Top');
  await page.keyboard.press('Escape');

  const card = page.getByRole('dialog', { name: 'Thread' });
  const current = () => card.locator('.comment-body').first();

  await page.keyboard.press('j');
  await expect(current()).toHaveText('Top');
  await expect(card.getByLabel('Thread 1 of 3')).toHaveText('1 / 3');
  await page.keyboard.press('j');
  await expect(current()).toHaveText('Middle');
  await page.keyboard.press('j');
  await expect(current()).toHaveText('Bottom');
  await page.keyboard.press('j');
  await expect(current()).toHaveText('Top');
  await page.keyboard.press('k');
  await expect(current()).toHaveText('Bottom');
  await expect(page.locator('.spotlight')).toBeVisible();

  await card.getByRole('button', { name: 'Previous thread' }).click();
  await expect(current()).toHaveText('Middle');
  await card.getByRole('button', { name: 'Next thread' }).click();
  await expect(current()).toHaveText('Bottom');
  await expect(card.getByRole('button', { name: 'Next thread' })).toHaveAttribute('title', 'Next thread (J)');

  // Typing a reply is never hijacked.
  await card.getByRole('textbox', { name: 'Reply' }).fill('');
  await card.getByRole('textbox', { name: 'Reply' }).pressSequentially('jk');
  await expect(card.getByRole('textbox', { name: 'Reply' })).toHaveValue('jk');
  await expect(current()).toHaveText('Bottom');

  // Resolved threads are skipped unless shown.
  await card.getByRole('button', { name: 'Resolve thread' }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('k');
  await expect(current()).toHaveText('Middle');
  await expect(card.getByLabel('Thread 2 of 2')).toBeVisible();

  // With just one thread visible the arrows go away.
  await card.getByRole('button', { name: 'Resolve thread' }).click();
  await page.mouse.click(5, 5);
  await page.keyboard.press('j');
  await expect(current()).toHaveText('Top');
  await expect(card.getByRole('button', { name: 'Next thread' })).toHaveCount(0);
});

test.describe('global comment shortcut', () => {
  const hint = (page: Page) => page.getByText('Click an element to start a thread');
  const appHandled = (page: Page) => page.evaluate(() => (window as unknown as { appHandled: number }).appHandled);
  async function ready(page: Page, query = '') {
    await page.goto(`/shortcut.html${query}`);
    // The overlay may come back open: it remembers that for the browser session.
    await expect(page.getByRole('button', { name: /^Show threads/ }).or(page.getByRole('toolbar', { name: 'OpenParley' }))).toBeVisible();
  }

  test('C starts a thread from anywhere, even with the overlay closed', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('c');
    await expect(hint(page)).toBeVisible();
    await page.locator('#intro').click();
    await expect(page.getByRole('dialog', { name: 'New thread' })).toBeVisible();
  });

  test('never while typing on the page', async ({ page }) => {
    await ready(page);
    await page.locator('#search').click();
    await page.keyboard.press('c');
    await expect(page.locator('#search')).toHaveValue('c');
    await page.locator('#notes').click();
    await page.keyboard.press('c');
    await expect(page.locator('#notes')).toHaveText('c');
    await page.waitForTimeout(100);
    await expect(hint(page)).toBeHidden();
  });

  test('stays out of the way when the page handles c itself', async ({ page }) => {
    for (const app of ['prevent', 'stop']) {
      await ready(page, `?app=${app}`);
      await page.keyboard.press('c');
      await page.waitForTimeout(100);
      expect(await appHandled(page)).toBe(1);
      await expect(hint(page)).toBeHidden();
    }
  });

  test('priority="openparley" takes the key before the page sees it', async ({ page }) => {
    await ready(page, '?app=prevent&priority=openparley');
    await page.keyboard.press('c');
    await expect(hint(page)).toBeVisible();
    expect(await appHandled(page)).toBe(0);
  });

  test('can be switched off or moved to another key', async ({ page }) => {
    await ready(page, '?shortcut=off');
    await page.keyboard.press('c');
    await page.waitForTimeout(100);
    await expect(hint(page)).toBeHidden();
    await page.getByRole('button', { name: /^Show threads/ }).click();
    await expect(page.getByRole('toolbar', { name: 'OpenParley' }).getByRole('button', { name: 'Comment' })).not.toHaveAttribute('aria-keyshortcuts');
    await expect(page.getByRole('toolbar', { name: 'OpenParley' }).getByRole('button', { name: 'Comment' }).locator('kbd')).toHaveCount(0);

    await ready(page, '?shortcut=n');
    await page.keyboard.press('c');
    await page.waitForTimeout(100);
    await expect(hint(page)).toBeHidden();
    const open = page.getByRole('button', { name: /^Show threads/ });
    if (await open.isVisible()) await open.click();
    await expect(page.getByRole('toolbar', { name: 'OpenParley' }).getByRole('button', { name: 'Comment' }).locator('kbd')).toHaveText('N');
    await page.keyboard.press('n');
    await expect(hint(page)).toBeVisible();
  });

  test('does not throw away an unsent thread', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('c');
    await page.locator('#intro').click();
    const dialog = page.getByRole('dialog', { name: 'New thread' });
    await dialog.getByLabel('Your name').fill('Ada');
    await dialog.getByRole('textbox', { name: /on your mind/ }).fill('Draft');
    await page.getByRole('heading', { name: 'Shortcut fixture' }).focus();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('c');
    await page.waitForTimeout(100);
    await expect(dialog.getByRole('textbox', { name: /on your mind/ })).toHaveValue('Draft');
  });
});

test('brand: logo, icon and Plus Jakarta Sans on the site and in the overlay', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'OpenParley' }).getByRole('img', { name: 'OpenParley' })).toBeVisible();
  expect(await page.locator('link[rel=icon]').getAttribute('href')).toBe('/brand/favicon.svg');
  expect(await page.locator('meta[property="og:image"]').getAttribute('content')).toBe('https://openparley.dev/og.png');
  expect((await page.request.get('/og.png')).headers()['content-type']).toBe('image/png');
  await expect.poll(() => page.evaluate(() => document.fonts.check("16px 'Plus Jakarta Sans'"))).toBe(true);
  expect(await page.locator('h1').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Plus Jakarta Sans');

  // The overlay loads its own copy of the font under a private name, and shows the parrot on the launcher.
  await expect(page.getByRole('button', { name: /^Show threads/ }).locator('svg')).toBeVisible();
  await page.getByRole('button', { name: /^Show threads/ }).click();
  await expect(page.getByRole('toolbar', { name: 'OpenParley' }).locator('.launcher-wordmark svg')).toBeVisible();
  const comment = page.getByRole('toolbar', { name: 'OpenParley' }).getByRole('button', { name: 'Comment' });
  expect(await comment.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?OpenParley Sans/);
  await expect.poll(() => page.evaluate(() => document.fonts.check("13px 'OpenParley Sans'"))).toBe(true);
});

test('cards near the bottom-right never slide under the toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#try');
  await openOverlay(page);
  // Scrolled so the price sits at the bottom of the screen, level with the toolbar.
  await page.locator('.price').evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().bottom - innerHeight + 40));
  await createThread(page, '.price', 'Not under the toolbar', 'Ada');
  const card = (await page.getByRole('dialog', { name: 'Thread' }).boundingBox())!;
  const toolbar = (await page.getByRole('toolbar', { name: 'OpenParley' }).boundingBox())!;
  expect(overlaps(card, toolbar)).toBe(false);
  expect(overlaps(card, (await page.locator('.price').boundingBox())!)).toBe(false);
});

test('a comment author lines up with their avatar', async ({ page }) => {
  await openOverlay(page);
  await createThread(page, '.price', 'nice', 'Ruben');
  await page.evaluate(() => document.fonts.ready);
  const card = page.getByRole('dialog', { name: 'Thread' });
  const avatar = (await card.locator('.comment .avatar').boundingBox())!;
  const name = (await card.locator('.comment-author').boundingBox())!;
  expect(Math.abs(avatar.y + avatar.height / 2 - (name.y + name.height / 2))).toBeLessThanOrEqual(1);
});
