import { FONT_FILES, FONT_LICENSE } from '@openparley/brand';
import { copyFile, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { gzipSync } from 'node:zlib';

// Every visitor downloads the loader, so it gets a much tighter budget than the app.
const LOADER_BUDGET = 2 * 1024;
// Raised from 24 KB (brand icon, J/K navigation), then from 28 KB (mentions). Only signed-in teammates
// download the app; the loader is what every visitor pays for.
const APP_BUDGET = 30 * 1024;
const outdir = new URL('../dist', import.meta.url).pathname;
// The stylesheet is imported as text and injected into the shadow root. Only whitespace and
// comments are stripped: Bun's CSS minifier rounds large integers (z-index 2147483647 -> 2147480000).
const cssPath = new URL('../src/ui/styles.css', import.meta.url).pathname;
const minifiedCss = (await Bun.file(cssPath).text())
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/\s*([{};])\s*/g, '$1')
  .trim();
const minifyCss: Bun.BunPlugin = {
  name: 'minified-css-text',
  setup(build) {
    build.onLoad({ filter: /styles\.css$/ }, () => ({ contents: `export default ${JSON.stringify(minifiedCss)};`, loader: 'js' }));
  },
};

await rm(outdir, { recursive: true, force: true });

// Fonts get content-hashed names too, so the server can cache them forever.
const fontFaces: { file: string; unicodeRange: string }[] = [];
for (const font of FONT_FILES) {
  const bytes = await Bun.file(font.path).bytes();
  const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex').slice(0, 8);
  const file = font.name.replace('plus-jakarta-sans', 'openparley-font').replace('.woff2', `-${hash}.woff2`);
  await Bun.write(`${outdir}/${file}`, bytes);
  fontFaces.push({ file, unicodeRange: font.unicodeRange });
}
await copyFile(FONT_LICENSE.path, `${outdir}/openparley-font-OFL.txt`);

// The app is content-hashed so it can be cached forever; the loader (short cache) points at it.
const app = await build({
  plugins: [minifyCss],
  entrypoints: [new URL('../src/index.ts', import.meta.url).pathname],
  naming: 'openparley-app-[hash].[ext]',
  format: 'esm',
  define: { __FONT_FACES__: JSON.stringify(fontFaces) },
});
const appFile = basename(app.path);

const loader = await build({
  entrypoints: [new URL('../src/loader.ts', import.meta.url).pathname],
  naming: 'openparley.[ext]',
  format: 'iife',
  define: { __APP_FILE__: JSON.stringify(appFile) },
});

let overBudget = false;
for (const [output, budget] of [[loader, LOADER_BUDGET], [app, APP_BUDGET]] as const) {
  const bytes = new Uint8Array(await output.arrayBuffer());
  const gzip = gzipSync(bytes).length;
  console.log(`${basename(output.path).padEnd(32)} ${(bytes.length / 1024).toFixed(1)} KB  (${(gzip / 1024).toFixed(1)} KB gzip, budget ${budget / 1024} KB)`);
  if (gzip > budget) overBudget = true;
}
if (overBudget) {
  console.error('A bundle exceeds its size budget.');
  process.exit(1);
}

async function build(config: Omit<Bun.BuildConfig, 'outdir' | 'target' | 'minify' | 'sourcemap'>): Promise<Bun.BuildArtifact> {
  const result = await Bun.build({ ...config, outdir, target: 'browser', minify: true, sourcemap: 'linked' });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  return result.outputs.find((o) => o.kind === 'entry-point')!;
}
