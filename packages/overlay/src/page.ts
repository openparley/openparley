const NAVIGATE_EVENT = 'openparley:navigate';
let historyPatched = false;

export function pageKey(pathname: string = location.pathname): string {
  let path = pathname.replace(/\/{2,}/g, '/');
  path = path.replace(/\/index\.html?$/i, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}

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
