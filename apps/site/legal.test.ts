import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { LEGAL } from './legal';
import { renderHtml } from './pages';

const page = (name: string) => Bun.file(join(import.meta.dir, 'public', `${name}.html`)).text();

describe('legal pages', () => {
  test('every {{legal.*}} field is filled in from legal.ts, and unknown fields fail', async () => {
    for (const name of ['imprint', 'terms', 'privacy', 'dpa']) {
      const html = renderHtml(await page(name));
      expect(html).not.toContain('{{');
      expect(html).toContain(LEGAL.updated);
    }
    expect(renderHtml(await page('imprint'))).toContain(LEGAL.kvk);
    expect(() => renderHtml('{{legal.nope}}')).toThrow('legal.nope');
  });

  test('the homepage and docs link every legal page', async () => {
    for (const name of ['index', 'docs']) {
      const html = await page(name);
      for (const path of ['/imprint', '/terms', '/privacy', '/dpa']) expect(html).toContain(`href="${path}"`);
    }
  });
});
