// Static dev server for the site. The overlay comes from packages/overlay/dist (run its build first).
import { BRAND_FILES, brandFontsCss } from '@openparley/brand';
import { join, normalize } from 'node:path';
import { generatedFiles, renderHtml } from './pages';

const port = Number(process.env.PORT ?? 3000);
const publicDir = join(import.meta.dir, 'public');
const overlayDir = join(import.meta.dir, '../../packages/overlay/dist');
// Extra static directory, used by the end-to-end tests for fixture pages.
const extraDir = process.env.EXTRA_STATIC_DIR ? join(process.cwd(), process.env.EXTRA_STATIC_DIR) : null;

const server = Bun.serve({
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    if (relative === '/brand/fonts.css') return new Response(brandFontsCss(), { headers: { 'content-type': 'text/css' } });
    const brand = relative.startsWith('/brand/') ? BRAND_FILES[relative.slice('/brand/'.length)] : undefined;
    if (brand) return new Response(Bun.file(brand));
    const generated = generatedFiles(await Bun.file(join(publicDir, 'docs.html')).text())[relative.slice(1)];
    if (generated !== undefined) {
      const type = relative.endsWith('.md') ? 'text/markdown' : relative.endsWith('.xml') ? 'text/xml' : 'text/plain';
      return new Response(generated, { headers: { 'content-type': `${type}; charset=utf-8` } });
    }
    const candidates = /^\/openparley[\w.-]*$/.test(relative)
      ? [join(overlayDir, relative)]
      : [publicDir, ...(extraDir ? [extraDir] : [])].flatMap((dir) => [join(dir, relative), join(dir, relative, 'index.html'), join(dir, `${relative}.html`)]);
    for (const path of candidates) {
      if (![publicDir, overlayDir, extraDir].some((dir) => dir && path.startsWith(dir))) continue;
      const file = Bun.file(path);
      if (!(await file.exists()) || path.endsWith('/')) continue;
      // Dev pages reference the team server as {{SYNC_URL}} so `bun run dev` can run on any port.
      if (extraDir && path.startsWith(extraDir) && path.endsWith('.html')) {
        const html = (await file.text()).replaceAll('{{SYNC_URL}}', process.env.DEV_SYNC_URL ?? 'http://localhost:3001');
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (path.startsWith(publicDir) && path.endsWith('.html')) {
        return new Response(renderHtml(await file.text()), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (path.endsWith('.txt')) return new Response(file, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return new Response(file);
    }
    return new Response('Not found', { status: 404 });
  },
});

console.log(`Site running at ${server.url}`);
