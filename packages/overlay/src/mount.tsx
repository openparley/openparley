import { render } from 'preact';
import { injectFont } from './font';
import { hashRequestsOverlay, whenGateOpens, type Launcher } from './gate';
import { pageKey } from './page';
import { parseShortcut, type ShortcutPriority } from './shortcut';
import { readShareHash } from './share';
import { LocalStore } from './store/local';
import { SyncStore } from './store/sync';
import { Tracker } from './tracker';
import { App } from './ui/App';
import css from './ui/styles.css' with { type: 'text' };

export interface OverlayOptions {
  /** Project key from your sync server. Omit to keep threads in the browser and share them by link. */
  project?: string;
  /** Sync server URL. Required together with `project`. */
  server?: string;
  /**
   * `always` (default): the launcher is visible to every visitor.
   * `auto`: hidden until someone opens a thread link or visits with `#openparley` in the URL;
   * after that it stays on for that browser. `#openparley=off` turns it off again.
   * `members` (needs `project`): only loads in browsers where someone signed in to the team
   * server. Teammates switch it on the first time with `#openparley` or a team thread link.
   */
  launcher?: Launcher;
  /**
   * Key that starts a new thread from anywhere on the page (never while typing in a field).
   * Default `'c'`. Any single key works; `false` turns it off.
   */
  shortcut?: string | false;
  /**
   * `'page'` (default): if the page handles the key itself (preventDefault or stopPropagation),
   * OpenParley stays out of the way. `'openparley'`: OpenParley handles it first and the page
   * never sees it.
   */
  shortcutPriority?: ShortcutPriority;
  /**
   * Team mode: threads show in the environment they were made in. By default every origin is its
   * own environment; give origins the same label (e.g. all preview deploys `'preview'`) to share.
   */
  environment?: string;
  /** Recorded on new threads, e.g. the deployed commit SHA, so a coding agent knows what code it was about. */
  revision?: string;
}

export interface Overlay {
  destroy(): void;
}

const ACTIVE_KEY = 'openparley:v1:active';
const HOST_TAG = 'openparley-overlay';

let current: Overlay | null = null;

/** Adds the OpenParley overlay to the page. Calling it again returns the existing instance. */
export function mount(options: OverlayOptions = {}): Overlay {
  if (current) return current;
  if (options.project && !options.server) {
    throw new Error('[openparley] `server` is required when `project` is set.');
  }

  parseShortcut(options.shortcut);
  if (options.launcher === 'members' && !options.project) {
    throw new Error('[openparley] `launcher: "members"` requires `project`.');
  }

  let mounted = null as Overlay | null;
  const stopWaiting = whenGateOpens(options, () => {
    mounted = mountNow(options);
  });
  current = {
    destroy() {
      stopWaiting();
      mounted?.destroy();
      current = null;
    },
  };
  return current;
}

function mountNow(options: OverlayOptions): Overlay {
  const host = document.createElement(HOST_TAG);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  const root = document.createElement('div');
  shadow.append(style, root);
  // Appended to <html> rather than <body> so it never shifts the page's own nth-of-type paths.
  document.documentElement.append(host);
  const removeFont = injectFont();

  const requested = hashRequestsOverlay();
  // Saved synchronously: an effect-based save could miss a navigation that follows immediately.
  if (requested) setSessionFlag(ACTIVE_KEY, true);
  removeOpenparleyHash();
  const page = pageKey();
  const store = options.project
    ? new SyncStore({
        server: options.server!,
        project: options.project,
        page,
        environment: options.environment || undefined,
        revision: options.revision || undefined,
      })
    : new LocalStore();
  const tracker = new Tracker();

  render(
    <App
      host={host}
      store={store}
      tracker={tracker}
      share={readShareHash(location.hash)}
      startActive={sessionFlag(ACTIVE_KEY) || requested}
      onActiveChange={(active) => setSessionFlag(ACTIVE_KEY, active)}
      shortcut={parseShortcut(options.shortcut)}
      shortcutPriority={options.shortcutPriority === 'openparley' ? 'openparley' : 'page'}
    />,
    root,
  );

  return {
    destroy() {
      render(null, root);
      store.destroy();
      tracker.destroy();
      host.remove();
      removeFont();
    },
  };
}

/** `#openparley` has done its job once the overlay is up; keep the address bar clean. */
function removeOpenparleyHash(): void {
  const parts = location.hash.replace(/^#/, '').split('&');
  if (!parts.includes('openparley')) return;
  const rest = parts.filter((part) => part && part !== 'openparley');
  history.replaceState(history.state, '', location.pathname + location.search + (rest.length ? `#${rest.join('&')}` : ''));
}

function sessionFlag(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function setSessionFlag(key: string, on: boolean): void {
  try {
    if (on) sessionStorage.setItem(key, '1');
    else sessionStorage.removeItem(key);
  } catch {
    // Not persisting the open/closed state is harmless.
  }
}
