import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { legalFields, renderLegal } from './legal';
import { renderHtml } from './pages';

const PAGES = ['imprint', 'terms', 'privacy', 'dpa'];
const page = (name: string) => Bun.file(join(import.meta.dir, 'public', `${name}.html`)).text();

const FULL = {
  operator: 'Jan Jansen',
  form: 'a sole proprietorship (eenmanszaak) registered in the Netherlands',
  address: 'Kade 1, 1000 AA Amsterdam, the Netherlands',
  kvk: '12345678',
  vat: 'NL000000000B01',
  email: 'support@openparley.dev',
  court: 'Amsterdam',
  updated: '1 January 2027',
};

describe('legal pages', () => {
  test('render without unpublished details, and the imprint offers them on request', async () => {
    for (const name of PAGES) {
      const html = renderHtml(await page(name));
      expect(html).not.toContain('{{');
      expect(html).not.toContain('null');
    }
    const imprint = renderHtml(await page('imprint'));
    expect(imprint).toContain('Our name, address, Chamber of Commerce (KvK) number and VAT number are available on request by email.');
    expect(renderHtml(await page('terms'))).toContain('Disputes go to the competent court in the Netherlands, unless');
  });

  test('every detail shows up once it is filled in', async () => {
    const fields = legalFields(FULL);
    const imprint = renderLegal(await page('imprint'), fields);
    for (const value of [FULL.operator, FULL.address, FULL.kvk, FULL.vat]) expect(imprint).toContain(value);
    expect(imprint).not.toContain('on request');
    expect(renderLegal(await page('terms'), fields)).toContain('provided by Jan Jansen, a sole proprietorship (eenmanszaak) registered in the Netherlands, Chamber of Commerce (KvK) number 12345678');
    expect(renderLegal(await page('terms'), fields)).toContain('the competent court in Amsterdam, the Netherlands');
    expect(renderLegal(await page('privacy'), fields)).toContain('KvK) number 12345678, Kade 1, 1000 AA Amsterdam');
    expect(() => renderLegal('{{legal.nope}}', fields)).toThrow('legal.nope');
  });

  test('the homepage and docs link every legal page', async () => {
    for (const name of ['index', 'docs']) {
      const html = await page(name);
      for (const path of PAGES) expect(html).toContain(`href="/${path}"`);
    }
  });
});
