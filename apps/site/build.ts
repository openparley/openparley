import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { BRAND_FILES, brandFontsCss } from '@openparley/brand';
import { join } from 'node:path';
import { missingLegalDetails } from './legal';
import { generatedFiles, renderHtml } from './pages';

const missing = missingLegalDetails();
if (missing.length > 0) console.warn(`Imprint without: ${missing.join(', ')} (offered on request). Add them in apps/site/legal.ts.`);
const out = join(import.meta.dir, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(import.meta.dir, 'public'), out, { recursive: true });
for (const file of (await readdir(out)).filter((name) => name.endsWith('.html'))) {
  await Bun.write(join(out, file), renderHtml(await Bun.file(join(out, file)).text()));
}
for (const [name, content] of Object.entries(generatedFiles(await Bun.file(join(out, 'docs.html')).text()))) {
  await Bun.write(join(out, name), content);
}
const overlayDist = join(import.meta.dir, '../../packages/overlay/dist');
for (const file of await readdir(overlayDist)) await cp(join(overlayDist, file), join(out, file));
await mkdir(join(out, 'brand'));
for (const [name, path] of Object.entries(BRAND_FILES)) await cp(path, join(out, 'brand', name));
await Bun.write(join(out, 'brand/fonts.css'), brandFontsCss());
console.log(`Site built to ${out}`);
