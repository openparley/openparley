import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { articleToMarkdown } from './markdown';
import { generatedFiles, renderHtml } from './pages';

const docsHtml = await Bun.file(join(import.meta.dir, 'public/docs.html')).text();

describe('docs for coding agents', () => {
  test('docs.md has every section of the docs page, with absolute links', () => {
    const md = generatedFiles(docsHtml)['docs.md']!;
    for (const [, heading] of docsHtml.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)) expect(md).toContain(`## ${heading!.replace(/&amp;/g, '&')}`);
    expect(md).toStartWith('# OpenParley docs\n');
    expect(md).toContain('[On production](https://openparley.dev/docs#production)');
    expect(md).not.toMatch(/<\/?(p|a|code|strong|td|li)\b/);
  });

  test('the AGENTS.md snippet is filled in, in the page and in docs.md', () => {
    expect(renderHtml(docsHtml)).not.toContain('{{');
    expect(renderHtml(docsHtml)).toContain('list_threads');
    expect(generatedFiles(docsHtml)['docs.md']).toContain('## OpenParley\n\nFeedback on the UI lives in OpenParley threads');
  });

  test('setup.md is the setup prompt with placeholders and tells the agent to ask for them', () => {
    const setup = generatedFiles(docsHtml)['setup.md']!;
    expect(setup).toContain('data-project="YOUR_PROJECT_KEY" data-launcher="members"');
    expect(setup).toContain('ask the user for it');
  });

  test('refuses HTML it does not know how to convert', () => {
    expect(() => articleToMarkdown('<article><p>ok</p><details>lost</details></article>', '/x')).toThrow('Unconverted HTML');
  });
});
