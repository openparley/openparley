// A project's allowed sites: exact origins (`https://shop.example.com`) or a subdomain wildcard
// (`https://*.preview.example.com`). A wildcard matches any depth of subdomain, never the base
// itself, and keeps the scheme and port exact: there's no `localhost:*`, because any local process
// can serve a page on some port.

/** A canonical http(s) origin, as browsers send it in `Origin` and as `location.origin` returns it. */
export function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    // `*` is legal in a URL host but never in a real origin; refusing it keeps the one-click add from adding a wildcard.
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value && !url.hostname.includes('*');
  } catch {
    return false;
  }
}

/** Parses one admin-entered entry into its normalised form, or explains what's wrong with it. */
export function parseOriginEntry(line: string): { entry: string } | { error: string } {
  const wildcard = /^(https?:\/\/)\*\.(.+)$/i.exec(line);
  let url: URL;
  try {
    url = new URL(wildcard ? `${wildcard[1]}${wildcard[2]}` : line);
  } catch {
    return { error: `"${line}" isn't a valid URL. Use the form https://example.com or https://*.example.com.` };
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin === 'null') {
    return { error: `"${line}" must start with http:// or https://.` };
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    return { error: `"${line}" should be just the origin, without a path: ${wildcard ? wildcardOf(url) : url.origin}` };
  }
  if (url.hostname.includes('*') || (!wildcard && line.includes('*'))) {
    return { error: `"${line}": a wildcard only works as the first part of the host, as in https://*.example.com.` };
  }
  if (!wildcard) return { entry: url.origin };
  const labels = url.hostname.split('.');
  if (labels.length < 2 || /^\d+$/.test(labels.at(-1)!) || url.hostname.startsWith('[')) {
    return { error: `"${line}" is too broad. Put the wildcard below a domain, as in https://*.example.com.` };
  }
  return { entry: wildcardOf(url) };
}

const wildcardOf = (url: URL) => `${url.protocol}//*.${url.host}`;

export const isWildcard = (entry: string) => entry.includes('//*.');

export function originMatches(entry: string, origin: string): boolean {
  if (!isWildcard(entry)) return entry === origin;
  if (!isOrigin(origin)) return false;
  const pattern = new URL(entry.replace('//*.', '//'));
  const site = new URL(origin);
  return site.protocol === pattern.protocol && site.port === pattern.port && site.hostname.endsWith(`.${pattern.hostname}`);
}

export const allows = (entries: string[], origin: string) => entries.some((entry) => originMatches(entry, origin));

/** Where a thread can be opened: the origin it was made on, else the page on every listed (non-wildcard) site of its project. */
export function threadUrls(thread: { page: string; environment?: string }, origins: readonly string[]): string[] {
  return thread.environment?.includes('://') ? [`${thread.environment}${thread.page}`] : origins.filter((origin) => !isWildcard(origin)).map((origin) => `${origin}${thread.page}`);
}
