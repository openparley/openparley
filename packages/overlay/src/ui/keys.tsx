// The one place that says which keys do what, so visible hints, tooltips and
// aria-keyshortcuts can't drift apart from the handlers.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const KEYS = {
  submit: { label: isMac ? '⌘↵' : 'Ctrl ↵', aria: 'Meta+Enter Control+Enter', text: isMac ? '⌘ Enter' : 'Ctrl+Enter' },
  escape: { label: 'Esc', aria: 'Escape', text: 'Esc' },
  next: { label: 'J', aria: 'J', text: 'J' },
  previous: { label: 'K', aria: 'K', text: 'K' },
} as const;

export type KeyName = keyof typeof KEYS;

/** A key hint; `label` is for keys that aren't fixed (e.g. the configurable comment key). */
export function Kbd(props: { name: KeyName } | { label: string }) {
  return (
    <kbd class="kbd" aria-hidden="true">
      {'name' in props ? KEYS[props.name].label : props.label}
    </kbd>
  );
}

/** Tooltip text with the shortcut, e.g. "Close (Esc)". */
export function withKey(label: string, name: KeyName): string {
  return `${label} (${KEYS[name].text})`;
}
