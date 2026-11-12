import { devices, expect, test, type Locator, type Page } from '@playwright/test';

test.use({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 } });

type Rect = { x: number; y: number; width: number; height: number };
const box = async (locator: Locator): Promise<Rect> => (await locator.boundingBox())!;

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'OpenParley' });
const spotlight = (page: Page) => page.locator('.spotlight');
const newThread = (page: Page) => page.getByRole('dialog', { name: 'New thread' });

/** A real touch drag (the browser scrolls and cancels the pointer), starting on `from`. */
async function swipe(page: Page, from: Locator, dy: number) {
  const start = await box(from);
  const x = Math.round(start.x + start.width / 2);
  const y = Math.round(start.y + start.height / 2);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, at: number) =>
    cdp.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: type === 'touchEnd' ? [] : [{ x, y: at }] });
  await touch('touchStart', y);
  for (let step = 1; step <= 10; step++) await touch('touchMove', y - (dy * step) / 10);
  await touch('touchEnd', y - dy);
  await cdp.detach();
}

/** Counts clicks and taps the page itself receives on `selector`. */
async function countPageEvents(page: Page, selector: string) {
  await page.evaluate((selector) => {
    const w = window as unknown as { pageEvents: string[] };
    w.pageEvents = [];
    for (const type of ['click', 'touchstart', 'touchend', 'pointerdown', 'mousedown']) {
      document.querySelector(selector)!.addEventListener(type, () => w.pageEvents.push(type));
    }
  }, selector);
  return () => page.evaluate(() => (window as unknown as { pageEvents: string[] }).pageEvents);
}

async function openOverlay(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^Show threads/ }).tap();
  await expect(toolbar(page)).toBeVisible();
}

test('tap highlights, a second tap starts the thread in a bottom sheet, the pin reopens it', async ({ page }) => {
  await openOverlay(page);
  const button = page.locator('[data-testid="add-to-cart"]');
  const pageEvents = await countPageEvents(page, '[data-testid="add-to-cart"]');
  await toolbar(page).getByRole('button', { name: 'Comment' }).tap();
  await expect(page.getByText('Tap an element, tap again to start a thread')).toBeVisible();
  await expect(page.getByText(/Esc to cancel/)).toHaveCount(0);
  // A finger has no hover: no pin follows it.
  await expect(page.locator('.pin[data-cursor]')).toBeHidden();

  await page.locator('.price').tap();
  await expect(spotlight(page)).toContainText('div.price');
  await button.tap();
  await expect(spotlight(page)).toContainText('button');
  await expect(newThread(page)).toHaveCount(0);

  await button.tap();
  const sheet = newThread(page);
  await expect(sheet).toBeVisible();
  expect(await pageEvents()).toEqual([]);

  // Full width at the bottom, with the toolbar out of the way and the element scrolled clear of it.
  await expect.poll(async () => {
    const rect = await box(sheet);
    return [rect.x, rect.width, Math.round(rect.y + rect.height)];
  }).toEqual([0, 390, 844]);
  expect(await sheet.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('28px');
  await expect(toolbar(page)).toBeHidden();
  await expect.poll(async () => {
    const [target, card] = [await box(button), await box(sheet)];
    return target.y >= 0 && target.y + target.height <= card.y;
  }).toBe(true);

  await sheet.getByLabel('Your name').fill('Ada');
  await sheet.getByRole('textbox', { name: /on your mind/ }).fill('Make this button bigger on phones');
  await sheet.getByRole('button', { name: 'Post' }).tap();
  const thread = page.getByRole('dialog', { name: 'Thread' });
  await expect(thread.getByText('Make this button bigger on phones')).toBeVisible();
  expect(await pageEvents()).toEqual([]);

  await thread.getByRole('button', { name: 'Close' }).tap();
  await expect(thread).toBeHidden();
  await expect(toolbar(page)).toBeVisible();
  await page.getByRole('button', { name: /^Thread by Ada/ }).tap();
  await expect(thread).toBeVisible();
  expect((await box(thread)).width).toBe(390);

  // The list is a sheet too.
  await thread.getByRole('button', { name: 'Close' }).tap();
  await toolbar(page).getByRole('button', { name: /^List threads/ }).tap();
  const list = page.getByRole('dialog', { name: 'Threads' });
  expect((await box(list)).width).toBe(390);
  await list.getByRole('button', { name: /Make this button bigger/ }).tap();
  await expect(thread).toBeVisible();
});

test('scrolling while picking never picks, and never moves the highlight', async ({ page }) => {
  await openOverlay(page);
  await toolbar(page).getByRole('button', { name: 'Comment' }).tap();
  const price = page.locator('.price');
  await price.tap();
  await expect(spotlight(page)).toContainText('div.price');

  // A swipe that starts on the highlighted element is a scroll, not the confirming tap.
  const before = await page.evaluate(() => scrollY);
  await swipe(page, price, 200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before);
  await expect(spotlight(page)).toContainText('div.price');
  await expect(newThread(page)).toHaveCount(0);

  // The pick is still waiting for its second tap.
  await price.tap();
  await expect(newThread(page)).toBeVisible();
});

test('scrolling keeps an unsent thread; tapping the page closes it', async ({ page }) => {
  await openOverlay(page);
  await toolbar(page).getByRole('button', { name: 'Comment' }).tap();
  await page.locator('.price').tap();
  await page.locator('.price').tap();
  const sheet = newThread(page);
  await sheet.getByRole('textbox', { name: /on your mind/ }).fill('Draft');

  const before = await page.evaluate(() => scrollY);
  await swipe(page, page.locator('h1'), -150);
  await expect.poll(() => page.evaluate(() => scrollY)).not.toBe(before);
  await expect(sheet.getByRole('textbox', { name: /on your mind/ })).toHaveValue('Draft');

  await page.locator('h1').tap();
  await expect(sheet).toBeHidden();
});

test('no keyboard hints on touch, and 44px touch targets', async ({ page }) => {
  await openOverlay(page);
  const comment = toolbar(page).getByRole('button', { name: 'Comment' });
  await expect(comment.locator('kbd')).toBeHidden();
  // Screen readers and tooltips still get the shortcut.
  await expect(comment).toHaveAttribute('aria-keyshortcuts', 'C');

  await comment.tap();
  await page.locator('.price').tap();
  await page.locator('.price').tap();
  const sheet = newThread(page);
  await expect(sheet.getByRole('button', { name: 'Post' }).locator('kbd')).toBeHidden();
  await expect(sheet.getByRole('button', { name: 'Cancel' }).locator('kbd')).toBeHidden();

  const hitArea = (locator: Locator) =>
    locator.evaluate((el) => {
      const [visual, extra] = [el.getBoundingClientRect(), getComputedStyle(el, '::after')];
      return [Math.max(visual.width, parseFloat(extra.width)), Math.max(visual.height, parseFloat(extra.height))];
    });
  for (const target of [sheet.getByRole('button', { name: 'Cancel' }), sheet.getByRole('button', { name: 'Post' })]) {
    const [width, height] = await hitArea(target);
    expect(width).toBeGreaterThanOrEqual(44);
    expect(height).toBeGreaterThanOrEqual(44);
  }
  await sheet.getByRole('button', { name: 'Cancel' }).tap();
  await expect(toolbar(page)).toBeVisible();
  expect(await hitArea(toolbar(page).getByRole('button', { name: 'Hide threads' }))).toEqual([44, 44]);
});

test.describe('a mouse on a narrow window', () => {
  test.use({ hasTouch: false, isMobile: false, deviceScaleFactor: 1, viewport: { width: 500, height: 800 } });

  test('still picks on the first click, and shows desktop hints in a sheet', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('c');
    await expect(page.getByText('Click an element to start a thread · Esc to cancel')).toBeVisible();
    await page.locator('.price').click();
    const sheet = newThread(page);
    await expect(sheet).toBeVisible();
    expect((await box(sheet)).width).toBe(500);
    await expect(sheet.getByRole('button', { name: 'Cancel' }).locator('kbd')).toBeVisible();
  });
});
