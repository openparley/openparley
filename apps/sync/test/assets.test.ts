import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETUP_TOKEN, harness } from './harness';

const dir = mkdtempSync(join(tmpdir(), 'openparley-assets-'));
writeFileSync(join(dir, 'openparley.js'), '/* loader */');
writeFileSync(join(dir, 'openparley-app-abc123.js'), '/* app */');
writeFileSync(join(dir, 'secret.txt'), 'nope');
writeFileSync(join(dir, 'openparley-font-latin-1a2b3c4d.woff2'), 'font');

test('serves the loader with a short cache and the hashed app as immutable, cross-origin', async () => {
  const { app } = harness({ overlayDir: dir });
  const loader = await app.request('http://parley.test/openparley.js');
  expect(loader.status).toBe(200);
  expect(loader.headers.get('cache-control')).toBe('public, max-age=300');
  expect(loader.headers.get('access-control-allow-origin')).toBe('*');

  const bundle = await app.request('http://parley.test/openparley-app-abc123.js');
  expect(bundle.status).toBe(200);
  expect(await bundle.text()).toBe('/* app */');
  expect(bundle.headers.get('content-type')).toContain('text/javascript');
  expect(bundle.headers.get('cache-control')).toContain('immutable');
});

test('only serves overlay files', async () => {
  const { app } = harness({ overlayDir: dir });
  for (const path of ['/secret.txt', '/openparley-app-abc123.js/../secret.txt', '/openparley-app-..%2Fsecret.txt', '/openparley-app-zzz.js']) {
    const res = await app.request(`http://parley.test${path}`);
    expect(await res.text()).not.toBe('nope');
    expect(res.status).not.toBe(200);
  }
});

test('serves overlay fonts cross-origin and immutable', async () => {
  const { app } = harness({ overlayDir: dir });
  const font = await app.request('http://parley.test/openparley-font-latin-1a2b3c4d.woff2');
  expect(font.status).toBe(200);
  expect(font.headers.get('content-type')).toBe('font/woff2');
  expect(font.headers.get('access-control-allow-origin')).toBe('*');
  expect(font.headers.get('cache-control')).toContain('immutable');
});

test('serves brand files for its own pages, and nothing else from /brand', async () => {
  const { app } = harness();
  const logo = await app.request('http://parley.test/brand/logo-light.svg');
  expect(logo.status).toBe(200);
  expect(logo.headers.get('content-type')).toContain('image/svg+xml');
  expect((await app.request('http://parley.test/brand/plus-jakarta-sans-latin.woff2')).status).toBe(200);
  for (const path of ['/brand/index.ts', '/brand/..%2Fpackage.json', '/brand/']) {
    expect((await app.request(`http://parley.test${path}`)).status).toBe(404);
  }
});

test('pages show the logo and allow only same-origin images and fonts', async () => {
  const { app } = harness();
  const res = await app.request(`http://parley.test/setup?token=${SETUP_TOKEN}`);
  const html = await res.text();
  expect(html).toContain('src="/brand/logo-light.svg"');
  expect(html).toContain("font-family:'Plus Jakarta Sans'");
  expect(res.headers.get('content-security-policy')).toContain("img-src 'self'; font-src 'self'");
});
