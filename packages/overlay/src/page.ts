import { LIMITS } from '@openparley/protocol';

const NAVIGATE_EVENT = 'openparley:navigate';
let historyPatched = false;

/** Where a thread was made: the base path it's grouped under, plus the variant of that page. */
export interface PageRef {
  page: string;
  search?: string;
  hash?: string;
}

// Ad and campaign parameters: the same page reached from an email or an ad is still the same page.
const TRACKING_PARAMS = new Set([
  'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'twclid', 'li_fat_id', 'igshid', 'yclid',
  'mc_cid', 'mc_eid', '_ga', '_gl', '_hsenc', '_hsmi', 'mkt_tok', 'srsltid',
]);

export function pageKey(pathname: string = location.pathname): string {
  let path = pathname.replace(/\/{2,}/g, '/');
  path = path.replace(/\/index\.html?$/i, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}

/** The query without tracking parameters, sorted by key so equal pages compare equal. */
export function pageSearch(search: string): string | undefined {
  const params = new URLSearchParams(search);
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) params.delete(key);
  }
  params.sort();
  const value = params.toString();
  return value && value.length < LIMITS.search ? `?${value}` : undefined;
}

/** Only route hashes identify a page; a plain `#section` is a scroll position. */
export function pageHash(hash: string): string | undefined {
  return /^#[/!]/.test(hash) && hash.length <= LIMITS.hash ? hash : undefined;
}

export function currentPage(): PageRef {
  const search = pageSearch(location.search);
  const hash = pageHash(location.hash);
  return { page: pageKey(), ...(search && { search }), ...(hash && { hash }) };
}

/** `?id=2#/specs`, or '' for the bare path (and for threads from before variants were recorded). */
export const variantOf = (ref: PageRef): string => (ref.search ?? '') + (ref.hash ?? '');

export const pathOf = (ref: PageRef): string => ref.page + variantOf(ref);

export const sameVariant = (a: PageRef, b: PageRef): boolean => a.page === b.page && variantOf(a) === variantOf(b);

/** Calls `onChange` after any client-side navigation (pushState, replaceState, back/forward, hash). */
export function watchNavigation(onChange: () => void): () => void {
  if (!historyPatched) {
    historyPatched = true;
    // Patched once and never restored: restoring would silently undo patches that
    // other scripts (routers, analytics) applied on top of ours.
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event(NAVIGATE_EVENT));
        return result;
      };
    }
  }
  window.addEventListener(NAVIGATE_EVENT, onChange);
  window.addEventListener('popstate', onChange);
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener(NAVIGATE_EVENT, onChange);
    window.removeEventListener('popstate', onChange);
    window.removeEventListener('hashchange', onChange);
  };
}
