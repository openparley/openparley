// Generated parts of the site, shared by the build (production) and serve.ts (dev and e2e), so both
// serve the same thing. The setup prompt and AGENTS.md snippet come from the sync server's source.
import { AGENTS_SNIPPET, setupPrompt } from '../../apps/sync/src/setup-prompt';
import { renderLegal } from './legal';
import { articleToMarkdown } from './markdown';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Fills `{{AGENTS_SNIPPET}}` and the `{{legal.*}}` business details in a page. */
export const renderHtml = (html: string) => renderLegal(html.replaceAll('{{AGENTS_SNIPPET}}', escapeHtml(AGENTS_SNIPPET)));

const ORIGIN = 'https://openparley.dev';
const PAGES = ['/', '/docs', '/imprint', '/terms', '/privacy', '/dpa'];
const DAY = 24 * 60 * 60 * 1000;

/** RFC 9116. Expires is required; a year past the build, so any deploy renews it. */
export function securityTxt(now = new Date()): string {
  const expires = new Date(Math.floor(now.getTime() / DAY) * DAY + 365 * DAY).toISOString();
  return [
    'Contact: mailto:support@openparley.dev',
    'Contact: https://github.com/openparley/openparley/security/advisories/new',
    `Expires: ${expires}`,
    'Preferred-Languages: en, nl',
    `Canonical: ${ORIGIN}/.well-known/security.txt`,
    'Policy: https://github.com/openparley/openparley/blob/master/SECURITY.md',
    '',
  ].join('\n');
}

export function generatedFiles(docsHtml: string): Record<string, string> {
  const docs = articleToMarkdown(renderHtml(docsHtml), '/docs').replace(
    /^# Docs\n/,
    '# OpenParley docs\n\n> Markdown version of https://openparley.dev/docs, for coding agents. Index: https://openparley.dev/llms.txt\n',
  );
  const setup = setupPrompt();
  const urls = PAGES.map((path) => `  <url><loc>${ORIGIN}${path}</loc></url>`).join('\n');
  return {
    'docs.md': docs,
    'setup.md': setup,
    'llms-full.txt': `${docs}\n---\n\n${setup}`,
    'robots.txt': `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    'sitemap.xml': `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    '.well-known/security.txt': securityTxt(),
  };
}
