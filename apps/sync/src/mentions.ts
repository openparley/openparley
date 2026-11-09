/**
 * Mentions are plain text, like Slack: `@handle` (a member's mention name), or `@Full Name` as
 * written by agents and people who don't use the picker. The text stays the source of truth, so
 * the protocol needs no mention field and agents (MCP) mention people the same way the overlay does.
 */
export function mentionedIds(text: string, members: ReadonlyArray<{ id: string; name: string; handle: string }>): Set<string> {
  const found = new Set<string>();
  if (!text.includes('@')) return found;
  const handles = new Map(members.filter((m) => m.handle).map((m) => [m.handle, m.id]));
  const names = members.map((m) => ({ id: m.id, name: m.name.trim().toLowerCase() })).filter((m) => m.name);
  const lower = text.toLowerCase();
  for (let at = lower.indexOf('@'); at !== -1; at = lower.indexOf('@', at + 1)) {
    if (at > 0 && isWordChar(lower[at - 1]!)) continue;
    // The longest reading wins: `@sam.smith` is the handle, `@Sam Smith` the full name, even when someone is called Sam.
    let best: { id: string; length: number } | null = null;
    // A handle may contain dots and dashes but doesn't end with one, so `@mia.` at the end of a sentence is Mia.
    const token = /^[a-z0-9._-]+/.exec(lower.slice(at + 1))?.[0].replace(/[.-]+$/, '') ?? '';
    if (handles.has(token)) best = { id: handles.get(token)!, length: token.length };
    for (const { id, name } of names) {
      if (name.length > (best?.length ?? 0) && lower.startsWith(name, at + 1) && !isWordChar(lower[at + 1 + name.length] ?? ' ')) best = { id, length: name.length };
    }
    if (best) found.add(best.id);
  }
  return found;
}

const isWordChar = (char: string) => /[\p{L}\p{N}_]/u.test(char);
