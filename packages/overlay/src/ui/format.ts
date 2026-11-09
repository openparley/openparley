// Colours of the mark, each with the initial's colour that keeps it readable (AA): [background, text].
const PALETTE = [
  ['#2c7f6b', '#fff'],
  ['#f2b33d', '#14181f'],
  ['#c2553c', '#fff'],
  ['#343a44', '#fff'],
  ['#1f5a4c', '#fff'],
  ['#d48a1f', '#14181f'],
  ['#e8846b', '#14181f'],
  ['#7cc7b2', '#14181f'],
] as const;

export function avatarStyle(id: string): { background: string; color: string } {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const [background, color] = PALETTE[Math.abs(hash) % PALETTE.length]!;
  return { background, color };
}

export function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

export function timeAgo(time: number, now = Date.now()): string {
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}

/** `https://staging.example.com` → `staging.example.com`; a `data-environment` label stays as it is. */
export function environmentLabel(environment: string): string {
  return environment.includes('://') ? environment.replace(/^[a-z]+:\/\//, '') : environment;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

export function describeElement(el: Element): string {
  let label = el.localName;
  if (el.id) label += `#${el.id}`;
  else if (el.classList.length) label += `.${el.classList[0]}`;
  return label.length > 48 ? `${label.slice(0, 47)}…` : label;
}

/** Clipboard API needs a secure context; fall back to a hidden textarea + execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}
