// Decides whether the overlay loads at all. Shared by the tiny script-tag loader and `mount()`,
// so it must stay dependency-free: everything imported here ships to every visitor.

export type Launcher = 'always' | 'auto' | 'members';

export interface GateOptions {
  launcher?: Launcher;
  /** Required for `members`: the flag is per sync server. */
  server?: string;
}

const ENABLED_KEY = 'openparley:v1:enabled';
const ON = /(^#|&)openparley(&|$)/;
const OFF = /(^#|&)openparley=off(&|$)/;
const SHARE = /(^#|&)parley=/;

export function normalizeServer(server: string): string {
  return server.replace(/\/+$/, '');
}

/** Set after a successful team sign-in; cleared only by signing out (not by token expiry). */
export function memberKey(server: string): string {
  return `openparley:v1:member:${normalizeServer(server)}`;
}

/** True when the URL asks for the overlay: `#openparley` or a thread share link. */
export function hashRequestsOverlay(hash: string = location.hash): boolean {
  return !OFF.test(hash) && (ON.test(hash) || SHARE.test(hash));
}

/**
 * - `always`: load for every visitor.
 * - `auto`: load once `#openparley` or a thread link was opened in this browser; `#openparley=off` resets.
 * - `members`: load only in browsers where someone signed in to the team server (or when the URL asks
 *   for it, so a teammate can sign in for the first time). `#openparley=off` resets.
 */
export function gateOpen(options: GateOptions, hash: string = location.hash): boolean {
  const launcher = options.launcher ?? 'always';
  if (launcher === 'always') return true;
  if (launcher === 'members' && !options.server) return false;
  const key = launcher === 'members' ? memberKey(options.server!) : ENABLED_KEY;
  if (OFF.test(hash)) {
    setFlag(key, false);
    return false;
  }
  if (hashRequestsOverlay(hash)) {
    // A link only switches `auto` on for good; `members` waits for an actual sign-in.
    if (launcher === 'auto') setFlag(key, true);
    return true;
  }
  return readFlag(key);
}

/** Runs `onOpen` as soon as the gate is open: now, or after a later `#openparley` hash change. */
export function whenGateOpens(options: GateOptions, onOpen: () => void): () => void {
  if (gateOpen(options)) {
    onOpen();
    return () => {};
  }
  const onHash = () => {
    if (!gateOpen(options)) return;
    window.removeEventListener('hashchange', onHash);
    onOpen();
  };
  window.addEventListener('hashchange', onHash);
  return () => window.removeEventListener('hashchange', onHash);
}

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function setFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // Without storage, gated modes simply need the hash on every visit.
  }
}
