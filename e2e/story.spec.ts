import { expect, test, type Locator, type Page } from '@playwright/test';

// The homepage's scroll story: site-only illustrations (aria-hidden), played by apps/site/public/story.js.

test.use({ viewport: { width: 1440, height: 900 } });

const opacity = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).opacity);

/** Scrolls so the element's top sits at `at` (fraction of the viewport height). */
const scrollTo = (page: Page, selector: string, at: number) =>
  page.locator(selector).first().evaluate((el, at) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - innerHeight * at), at);

async function expectEndStates(page: Page) {
  await expect(page.locator('html')).not.toHaveClass(/story/);
  await expect(page.locator('.how')).not.toHaveAttribute('data-step');
  // Every beat's last frame, without waiting for anything.
  for (const selector of [
    '.hero-title .s-pin',
    '.s-outline',
    '.s-hero-reply',
    '.s-presence',
    '.s-cart-pin',
    '.s-resolved',
    '.s-shop .s-pin',
    '.s-preview',
    '.s-ask',
    '.s-faq',
    '.s-faq-answer',
    '.s-setup .s-pin',
    '.s-note',
  ]) {
    for (const el of await page.locator(selector).all()) {
      await expect(el, selector).toBeVisible();
      expect(await opacity(el), selector).toBe('1');
    }
  }
  await expect(page.locator('.s-hero-thread .s-type')).toHaveText('Love it. Could the hero show it working, instead of telling?');
  await expect(page.locator('.s-type > span')).toHaveCount(0);
  // The pin shows the resolved check: neither the draft nor the open face covers it.
  for (const face of await page.locator('.s-cart-pin .s-face').all()) expect(await opacity(face)).toBe('0');
  await expect(page.locator('.s-composer')).toBeHidden();
  await expect(page.locator('.s-agent')).toBeHidden();
  expect(await opacity(page.locator('.s-typing'))).toBe('0');
}

test.describe('end states without motion', () => {
  test('with reduced motion, every beat shows its end state at once', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('/');
    await expectEndStates(page);
    await context.close();
  });

  test('without JavaScript too', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');
    await expectEndStates(page);
    await context.close();
  });
});

test.describe('with motion', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('the hero thread plays on load', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/story/);
    await expect(page.locator('.hero')).toHaveClass(/play/);
    // The full text is in the DOM from the start, one span per character.
    await expect(page.locator('.s-hero-thread .s-type')).toHaveText('Love it. Could the hero show it working, instead of telling?');
    await expect(page.locator('.s-hero-reply')).toHaveCSS('opacity', '1', { timeout: 10_000 });
    await expect(page.locator('.s-presence')).toHaveCSS('opacity', '1', { timeout: 10_000 });
  });

  test('a beat scrolled away mid-way is finished at once', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.hero')).toHaveClass(/play/);
    await scrollTo(page, '#pricing', 0);
    await expect(page.locator('.hero')).toHaveClass(/s-now/);
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await opacity(page.locator('.s-hero-reply'))).toBe('1');
    expect(await opacity(page.locator('.s-presence'))).toBe('1');
  });

  test('scrolling through How it works steps the demo', async ({ page }) => {
    await page.goto('/');
    const how = page.locator('.how');
    await expect(how).toHaveAttribute('data-step', '0');
    await expect(page.locator('.s-resolved')).toBeHidden();

    await scrollTo(page, '.how .step:nth-child(1)', 0.3);
    await expect(how).toHaveAttribute('data-step', '1');
    await expect(page.locator('.s-composer')).toBeVisible();
    await expect(page.locator('.s-composer .s-type > span').last()).toHaveCSS('opacity', '1', { timeout: 10_000 });
    await expect(page.locator('.s-face.draft')).toHaveCSS('opacity', '1');

    await scrollTo(page, '.how .step:nth-child(2)', 0.3);
    await expect(how).toHaveAttribute('data-step', '2');
    await expect(page.locator('.s-composer')).toBeHidden();
    await expect(page.locator('.s-agent-reply')).toHaveCSS('opacity', '1');
    await expect(page.locator('.s-face.open')).toHaveCSS('opacity', '1');

    await scrollTo(page, '.how .step:nth-child(3)', 0.3);
    await expect(how).toHaveAttribute('data-step', '3');
    await expect(page.locator('.s-resolved')).toBeVisible();
    await expect(page.locator('.s-face.open')).toHaveCSS('opacity', '0');

    // Scrolling back shows that step again, already played.
    await scrollTo(page, '.how .step:nth-child(1)', 0.3);
    await expect(how).toHaveAttribute('data-step', '1');
    await expect(page.locator('.s-composer')).toBeVisible();
    expect(await opacity(page.locator('.s-composer .s-type > span').last())).toBe('1');
  });

  test('the team section drops one pin per role and keeps them', async ({ page }) => {
    await page.goto('/');
    const pins = page.locator('.s-shop .s-pin');
    await expect(pins.and(page.locator('.on'))).toHaveCount(0);
    await scrollTo(page, '.role:nth-child(1)', 0.5);
    await expect(page.locator('.role:nth-child(1)')).toHaveClass(/on/);
    await expect(page.locator('.role:nth-child(4)')).not.toHaveClass(/on/);
    await scrollTo(page, '.role:nth-child(4)', 0.3);
    await expect(pins.and(page.locator('.on'))).toHaveCount(4);
    await scrollTo(page, '.team', 1);
    await expect(pins.and(page.locator('.on'))).toHaveCount(4);
  });

  test('pricing and setup play when they come into view', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.s-team-plan')).not.toHaveClass(/play/);
    await scrollTo(page, '.s-team-plan', 0.4);
    await expect(page.locator('.s-team-plan')).toHaveClass(/play/);
    await expect(page.locator('.s-faq-answer')).toHaveCSS('opacity', '1');
    await scrollTo(page, '.s-setup', 0.4);
    await expect(page.locator('.s-setup')).toHaveClass(/play/);
    await expect(page.locator('.s-note')).toHaveCSS('opacity', '1');
  });
});

test('the real overlay still opens and picks on the illustrations', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Show threads/ }).click();
  await expect(page.getByRole('toolbar', { name: 'OpenParley' })).toBeVisible();
  await page.keyboard.press('c');
  await page.locator('.s-shop .s-title').click();
  const dialog = page.getByRole('dialog', { name: 'New thread' });
  await dialog.getByLabel('Your name').fill('Ada');
  await dialog.getByRole('textbox', { name: /on your mind/ }).fill('Pinned on the story');
  await dialog.getByRole('button', { name: 'Post' }).click();
  await expect(page.getByRole('dialog', { name: 'Thread' }).getByText('Pinned on the story')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Thread by Ada/ })).toBeVisible();
});

test('touch devices read "tap the parrot" instead of a key', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('Tap the parrot, tap')).toBeVisible();
  await expect(page.locator('.steps kbd')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await context.close();
});
