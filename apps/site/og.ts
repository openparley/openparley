// Renders the social share card (public/og.png, 1200x630) in Chromium. Run after changing the hero copy:
// `bun run --cwd apps/site og`.
import { chromium } from '@playwright/test';
import { BRAND_FILES, FONT_FILES } from '@openparley/brand';
import { join } from 'node:path';

const dataUrl = async (path: string, type: string) =>
  `data:${type};base64,${Buffer.from(await Bun.file(path).arrayBuffer()).toString('base64')}`;

// setContent pages can't load file:// fonts, so they are inlined.
const sans = await dataUrl(FONT_FILES[0]!.path, 'font/woff2');
const serif = await dataUrl(BRAND_FILES['instrument-serif-italic-latin.woff2']!, 'font/woff2');
const logo = await dataUrl(BRAND_FILES['logo-light.svg']!, 'image/svg+xml');
const icon = await Bun.file(BRAND_FILES['icon.svg']!).text();

const html = `<!doctype html><style>
@font-face { font-family: Sans; src: url(${sans}) format('woff2'); font-weight: 200 800; }
@font-face { font-family: Serif; src: url(${serif}) format('woff2'); font-style: italic; }
* { box-sizing: border-box; }
body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #fbf7ee; color: #14181f;
  font-family: Sans, sans-serif; position: relative; }
.copy { position: absolute; left: 80px; top: 76px; width: 620px; }
.logo { height: 48px; display: block; }
h1 { font-size: 72px; font-weight: 800; line-height: 1.02; letter-spacing: -0.02em; margin: 60px 0 28px; white-space: nowrap; }
h1 em { display: block; font: italic 400 1.1em/1 Serif, serif; letter-spacing: 0; color: #2c7f6b; }
p { font-size: 26px; line-height: 1.4; color: #5e6672; margin: 0; }
.url { position: absolute; left: 80px; bottom: 64px; font-size: 22px; font-weight: 700; color: #1f5a4c; }

.scene { position: absolute; left: 730px; top: 120px; width: 400px; }
.page { background: #fff; border: 1px solid #e7dec9; border-radius: 18px; padding: 28px; box-shadow: 0 8px 24px -8px rgb(90 67 16 / .12); }
.bar { height: 14px; border-radius: 7px; background: #f3ecdc; margin-bottom: 12px; }
.target { margin-top: 22px; display: inline-block; padding: 14px 24px; border-radius: 999px; background: #2c7f6b; color: #fff;
  font-size: 20px; font-weight: 700; outline: 3px solid #f2b33d; outline-offset: 5px; position: relative; }
.pin { position: absolute; right: -30px; top: -34px; width: 48px; height: 48px; filter: drop-shadow(0 4px 6px rgb(20 24 31 / .2)); }
.pin svg { display: block; width: 100%; height: 100%; }
.card { position: absolute; left: 40px; top: 240px; width: 370px; background: #fff; border-radius: 18px; padding: 20px 22px;
  border: 1px solid #e7dec9; box-shadow: 0 18px 40px -12px rgb(90 67 16 / .22); font-size: 19px; line-height: 1.4; }
.msg { display: flex; gap: 12px; }
.msg + .msg { margin-top: 14px; padding-top: 14px; border-top: 1px solid #f3ecdc; }
.avatar { flex: none; width: 34px; height: 34px; border-radius: 50%; background: #f2b33d; color: #14181f; font-weight: 800;
  font-size: 16px; display: grid; place-items: center; }
.avatar.agent { background: #14181f; color: #fbf7ee; }
.name { font-weight: 700; font-size: 16px; color: #5e6672; }
</style>
<div class="copy">
  <img class="logo" src="${logo}">
  <h1>Stop describing. <em>Start pointing.</em></h1>
  <p>Comment on any element of your live site. Your team and your coding agent reply in the thread.</p>
</div>
<div class="url">openparley.dev</div>
<div class="scene">
  <div class="page">
    <div class="bar" style="width: 70%"></div>
    <div class="bar" style="width: 92%"></div>
    <div class="bar" style="width: 56%"></div>
    <div class="target">Start free trial<div class="pin">${icon}</div></div>
  </div>
  <div class="card">
    <div class="msg"><div class="avatar">A</div><div><div class="name">Ada</div>Wraps onto two lines on mobile.</div></div>
    <div class="msg"><div class="avatar agent">AI</div><div><div class="name">Coding agent</div>Fixed in #142, preview is up.</div></div>
  </div>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(import.meta.dir, 'public/og.png') });
await browser.close();
console.log('Wrote public/og.png');
