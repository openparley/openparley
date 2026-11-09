// Generated parts of the site, shared by the build (production) and serve.ts (dev and e2e), so both
// serve the same thing. The setup prompt and AGENTS.md snippet come from the sync server's source.
import { AGENTS_SNIPPET, setupPrompt } from '../../apps/sync/src/setup-prompt';
import { articleToMarkdown } from './markdown';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Fills `{{AGENTS_SNIPPET}}` in a page. */
export const renderHtml = (html: string) => html.replaceAll('{{AGENTS_SNIPPET}}', escapeHtml(AGENTS_SNIPPET));

export function generatedFiles(docsHtml: string): Record<string, string> {
  const docs = articleToMarkdown(renderHtml(docsHtml), '/docs').replace(
    /^# Docs\n/,
    '# OpenParley docs\n\n> Markdown version of https://openparley.dev/docs, for coding agents. Index: https://openparley.dev/llms.txt\n',
  );
  const setup = setupPrompt();
  return { 'docs.md': docs, 'setup.md': setup, 'llms-full.txt': `${docs}\n---\n\n${setup}` };
}
