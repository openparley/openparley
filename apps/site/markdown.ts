// Turns the docs page into Markdown for coding agents (docs.md, llms-full.txt). Handles only the
// handful of tags docs.html uses; the test fails when the page gains one this doesn't know.

const SITE = 'https://openparley.dev';

const decode = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const absolute = (href: string, page: string) =>
  href.startsWith('#') ? `${SITE}${page}${href}` : href.startsWith('/') ? `${SITE}${href}` : href;

function inline(html: string, page: string): string {
  return decode(
    html
      .replace(/<(code|kbd)>([\s\S]*?)<\/\1>/g, (_, _tag, text: string) => `\`${text.replace(/\s+/g, ' ')}\``)
      .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
      .replace(/<em>([\s\S]*?)<\/em>/g, '*$1*')
      .replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, href: string, text: string) => `[${text}](${absolute(href, page)})`)
      .replace(/<br\s*\/?>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function table(html: string, page: string): string {
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row!.matchAll(/<t[hd]>([\s\S]*?)<\/t[hd]>/g)].map(([, cell]) => inline(cell!, page).replace(/\|/g, '\\|')),
  );
  const [head = [], ...body] = rows;
  return [head, head.map(() => '---'), ...body].map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

/** Markdown for the `<article>` of a site page. `page` is its path, for turning `#anchor` links absolute. */
export function articleToMarkdown(html: string, page: string): string {
  const article = html.match(/<article>([\s\S]*?)<\/article>/)?.[1];
  if (!article) throw new Error(`No <article> in ${page}`);
  const blocks: string[] = [];
  const known = /<(h[1-3]|p|ol|ul|pre|table)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let rest = article;
  for (const match of article.matchAll(known)) {
    const [whole, tag, body] = match as unknown as [string, string, string];
    rest = rest.replace(whole, '');
    if (tag.startsWith('h')) blocks.push(`${'#'.repeat(Number(tag[1]))} ${inline(body, page)}`);
    else if (tag === 'p') blocks.push(inline(body, page));
    else if (tag === 'pre') blocks.push(`\`\`\`\n${decode(body.replace(/^<code>|<\/code>$/g, ''))}\n\`\`\``);
    else if (tag === 'table') blocks.push(table(body, page));
    else {
      const items = [...body.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, item]) => inline(item!, page));
      blocks.push(items.map((item, i) => `${tag === 'ol' ? `${i + 1}.` : '-'} ${item}`).join('\n'));
    }
  }
  const leftover = rest.replace(/\s+/g, ' ').trim();
  if (leftover) throw new Error(`Unconverted HTML in ${page}: ${leftover.slice(0, 120)}`);
  return `${blocks.join('\n\n')}\n`;
}
