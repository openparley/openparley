// The global "start a thread" key. It must never steal a keystroke the host page or the user
// meant for something else, so by default it acts only after the page had its say.

export type ShortcutPriority = 'page' | 'openparley';

export interface ShortcutOptions {
  /** A single key (case-insensitive). */
  key: string;
  /**
   * `page` (default): the page's own keydown handlers run first; if any of them calls
   * preventDefault() or stops propagation, OpenParley ignores the key.
   * `openparley`: OpenParley handles the key first and hides it from the page.
   */
  priority: ShortcutPriority;
  /** OpenParley's own shadow host: keys typed inside it are never treated as the shortcut. */
  host: Element;
  onTrigger: () => void;
}

/** `'c'` by default; `false`/`'off'`/`''` disables. Throws on anything that isn't a single key. */
export function parseShortcut(value: string | false | undefined): string | null {
  if (value === undefined) return 'c';
  if (value === false || value === '' || value === 'off' || value === 'false') return null;
  const key = value.trim().toLowerCase();
  if ([...key].length !== 1 || /\s/.test(key)) {
    throw new Error(`[openparley] \`shortcut\` must be a single key like "c", or false. Got "${value}".`);
  }
  return key;
}

export function listenForShortcut({ key, priority, host, onTrigger }: ShortcutOptions): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const matches = (event: KeyboardEvent) =>
    event.key.toLowerCase() === key &&
    !event.repeat &&
    !event.isComposing &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !isTyping(event, host);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !matches(event)) return;
    if (priority === 'openparley') {
      event.preventDefault();
      event.stopImmediatePropagation();
      onTrigger();
      return;
    }
    // Other window listeners (including ones added after ours) haven't run yet. Waiting one task
    // lets every synchronous handler finish; defaultPrevented then tells us whether the page used it.
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!event.defaultPrevented) onTrigger();
    });
    timers.add(timer);
  };

  // `page`: bubble phase on window, the last stop, so stopPropagation() by the page also wins.
  const capture = priority === 'openparley';
  window.addEventListener('keydown', onKeyDown, capture);
  return () => {
    window.removeEventListener('keydown', onKeyDown, capture);
    for (const timer of timers) clearTimeout(timer);
  };
}

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/** True when the key is going into something editable, on the page or inside any shadow root. */
function isTyping(event: KeyboardEvent, host: Element): boolean {
  const path = event.composedPath();
  if (path.includes(host)) {
    const origin = path[0];
    return origin instanceof HTMLElement && isEditable(origin);
  }
  for (const node of path) {
    if (node === document.body) break;
    if (node instanceof HTMLElement && isEditable(node)) return true;
  }
  return isEditable(deepActiveElement());
}

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(el.type);
  }
  return TEXT_ROLES.has(el.getAttribute('role') ?? '');
}

function deepActiveElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}
