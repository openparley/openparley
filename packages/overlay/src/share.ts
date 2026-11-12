import { ANCHOR_VERSION, LIMITS, type Anchor, type Thread } from '@openparley/protocol';

export const HASH_KEY = 'parley';
const PREFIX = `${HASH_KEY}=`;

export type SharePayload =
  | { kind: 'threads'; threads: Thread[] }
  | { kind: 'ref'; threadId: string };

/** Reads `#parley=...` from a URL hash. Returns null when absent or unreadable. */
export async function readShareHash(hash: string): Promise<SharePayload | null> {
  const value = hashParts(hash)
    .find((part) => part.startsWith(PREFIX))
    ?.slice(PREFIX.length);
  if (!value) return null;
  if (value.startsWith('t.')) {
    const threadId = value.slice(2);
    return /^[A-Za-z0-9_-]{1,64}$/.test(threadId) ? { kind: 'ref', threadId } : null;
  }
  try {
    const threads = await decodeThreads(value);
    return threads.length ? { kind: 'threads', threads } : null;
  } catch {
    return null;
  }
}

/** Returns `hash` without the share parameter, keeping anything else that was in it. */
export function stripShareHash(hash: string): string {
  const rest = hashParts(hash).filter((part) => !part.startsWith(PREFIX));
  return rest.length ? `#${rest.join('&')}` : '';
}

function hashParts(hash: string): string[] {
  return hash.replace(/^#/, '').split('&').filter(Boolean);
}

export function refLink(base: URL, threadId: string): string {
  return withHash(base, `t.${threadId}`);
}

export async function threadsLink(base: URL, threads: Thread[]): Promise<string> {
  return withHash(base, await encodeThreads(threads));
}

function withHash(base: URL, value: string): string {
  const url = new URL(base.href);
  url.hash = `${HASH_KEY}=${value}`;
  return url.href;
}

export async function encodeThreads(threads: Thread[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ threads }));
  if (typeof CompressionStream === 'function') {
    return `z1.${toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')))}`;
  }
  return `j1.${toBase64Url(bytes)}`;
}

export async function decodeThreads(value: string): Promise<Thread[]> {
  const [format, data = ''] = value.split('.', 2);
  let bytes = fromBase64Url(data);
  if (format === 'z1') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  else if (format !== 'j1') throw new Error('Unknown share format');
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const list = isRecord(parsed) && Array.isArray(parsed.threads) ? parsed.threads : [];
  return list.filter(isThread).slice(0, 50);
}

async function pipe(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

// Share links are attacker-controlled input, so every field is checked before use.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown, max: number, min = 0): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isAuthor(value: unknown): boolean {
  return isRecord(value) && isString(value.id, 64, 1) && isString(value.name, LIMITS.authorName);
}

export function isAnchor(value: unknown): value is Anchor {
  if (!isRecord(value) || value.v !== ANCHOR_VERSION) return false;
  const { point, attrs } = value;
  return (
    isString(value.selector, LIMITS.anchorSelector) &&
    isString(value.path, LIMITS.anchorPath) &&
    isString(value.tag, 64, 1) &&
    isString(value.text, LIMITS.anchorText) &&
    isRecord(attrs) &&
    Object.keys(attrs).length <= 20 &&
    Object.values(attrs).every((v) => isString(v, LIMITS.anchorAttrValue)) &&
    Array.isArray(point) &&
    point.length === 2 &&
    point.every((n) => typeof n === 'number' && n >= 0 && n <= 1)
  );
}

export function isThread(value: unknown): value is Thread {
  if (!isRecord(value)) return false;
  return (
    isString(value.id, 64, 1) &&
    isString(value.page, 2048, 1) &&
    (value.search === undefined || (isString(value.search, LIMITS.search, 2) && value.search.startsWith('?'))) &&
    (value.hash === undefined || (isString(value.hash, LIMITS.hash, 2) && /^#[/!]/.test(value.hash))) &&
    (value.environment === undefined || isString(value.environment, LIMITS.environment, 1)) &&
    (value.revision === undefined || isString(value.revision, LIMITS.revision, 1)) &&
    isAnchor(value.anchor) &&
    (value.status === 'open' || value.status === 'resolved') &&
    isTime(value.statusAt) &&
    isTime(value.createdAt) &&
    isAuthor(value.author) &&
    Array.isArray(value.comments) &&
    value.comments.length <= 500 &&
    value.comments.every(
      (c) =>
        isRecord(c) &&
        isString(c.id, 64, 1) &&
        isAuthor(c.author) &&
        (c.agent === undefined || isString(c.agent, LIMITS.agentName, 1)) &&
        isString(c.body, LIMITS.commentBody, 1) &&
        isTime(c.createdAt),
    )
  );
}
