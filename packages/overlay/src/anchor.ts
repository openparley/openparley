import {
  finder,
  attr as finderAttr,
  className as finderClassName,
} from '@medv/finder';
import { ANCHOR_VERSION, LIMITS, type Anchor } from '@openparley/protocol';

export interface Match {
  element: Element;
  /** True when the unique selector still points at an element with identical text. */
  exact: boolean;
}

const IDENTITY_ATTRS = [
  'id',
  'data-testid',
  'data-test',
  'data-test-id',
  'data-cy',
  'data-qa',
  'name',
  'aria-label',
  'role',
  'href',
  'alt',
  'title',
  'placeholder',
  'for',
  'type',
];
const SELECTOR_ATTRS = new Set(['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa', 'name', 'aria-label', 'role', 'for']);
const LOOKUP_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa', 'id'];

// Framework-generated ids (React useId, Radix, Ember...) and hashes change between renders or builds.
const GENERATED_ID = /^\d|^:|:$|[0-9a-f]{8}|\d{3,}|^(ember|react|radix|headlessui|rc|cdk|mat|ng)-/i;
const GENERATED_CLASS_PREFIX = /^(css|sc|jsx|svelte|emotion)-/i;

const MIN_SCORE = 3;

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function elementText(el: Element): string {
  return normalizeText(el.textContent ?? '').slice(0, LIMITS.anchorText);
}

export function createAnchor(el: Element, clientX: number, clientY: number): Anchor {
  const rect = el.getBoundingClientRect();
  return {
    v: ANCHOR_VERSION,
    selector: uniqueSelector(el).slice(0, LIMITS.anchorSelector),
    path: structuralPath(el).slice(0, LIMITS.anchorPath),
    tag: el.localName,
    text: elementText(el),
    attrs: identityAttrs(el),
    point: [fraction(clientX - rect.left, rect.width), fraction(clientY - rect.top, rect.height)],
  };
}

export function resolveAnchor(anchor: Anchor, doc: Document = document): Match | null {
  const bonus = new Map<Element, number>();
  const consider = (elements: Element[], points: number) => {
    for (const el of elements) bonus.set(el, Math.max(bonus.get(el) ?? 0, points));
  };

  const bySelector = queryAll(doc, anchor.selector, 50);
  consider(bySelector, bySelector.length === 1 ? 2 : 0.5);
  consider(queryAll(doc, anchor.path, 1), 1);
  for (const name of LOOKUP_ATTRS) {
    const value = anchor.attrs[name];
    if (value) consider(queryAll(doc, `[${name}="${cssEscape(value)}"]`, 10), 1.5);
  }

  let best: Element | null = null;
  let bestScore = -Infinity;
  for (const [el, points] of bonus) {
    if (el.localName !== anchor.tag) continue;
    const text = elementText(el);
    // Two empty texts say little about identity (icons, inputs, images), so they only count half.
    const textScore = !anchor.text && !text ? 0.5 : textSimilarity(anchor.text, text);
    const score = points + 3 * textScore + attrScore(anchor.attrs, el);
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }

  if (best && bestScore >= MIN_SCORE) {
    const exact = bySelector.length === 1 && bySelector[0] === best && elementText(best) === anchor.text;
    return { element: best, exact };
  }

  const byText = findByExactText(anchor, doc);
  return byText ? { element: byText, exact: false } : null;
}

// Shared by too many unrelated elements to tell them apart.
const WEAK_ATTRS = new Set(['role', 'type']);

/**
 * Whether a thread made on another variant of this page (`?id=1` while on `?id=2`) belongs on this
 * element too. Only an exact match counts, and it must say something about identity: the same text,
 * or for elements without text (icons, images) the same identifying attributes. A wrong pin is worse
 * than a missing one.
 */
export function sticks(anchor: Anchor, match: Match | null | undefined): boolean {
  if (!match?.exact) return false;
  if (anchor.text) return true;
  const names = Object.keys(anchor.attrs);
  return names.some((name) => !WEAK_ATTRS.has(name)) && names.every((name) => match.element.getAttribute(name) === anchor.attrs[name]);
}

/** Dice coefficient over character bigrams; 1 for identical strings. */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 0.95;
  if (x.length < 2 || y.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const gram = x.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const gram = y.slice(i, i + 2);
    const n = counts.get(gram) ?? 0;
    if (n > 0) {
      overlap++;
      counts.set(gram, n - 1);
    }
  }
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

function uniqueSelector(el: Element): string {
  if (!el.ownerDocument.body?.contains(el)) return '';
  try {
    return finder(el, {
      timeoutMs: 150,
      idName: stableId,
      className: stableClass,
      attr: (name, value) => SELECTOR_ATTRS.has(name) && value.length <= 80 && finderAttr(name, value),
    });
  } catch {
    return '';
  }
}

export function stableId(id: string): boolean {
  return id.length <= 64 && !GENERATED_ID.test(id) && !/\s/.test(id);
}

/**
 * Word-like class names only (finder's heuristic), extended to BEM (`card__title--active`).
 * Rejects utility classes with digits or variants (`mt-4`, `hover:x`) and CSS-module hashes.
 */
export function stableClass(name: string): boolean {
  if (GENERATED_CLASS_PREFIX.test(name)) return false;
  return name.split(/__|--/).every((part) => finderClassName(part));
}

function structuralPath(el: Element): string {
  const steps: string[] = [];
  const body = el.ownerDocument.body;
  let node: Element | null = el;
  while (node && node !== body) {
    const parent: Element | null = node.parentElement;
    if (!parent) return '';
    let index = 1;
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.localName === node.localName) index++;
    }
    steps.unshift(`${cssEscape(node.localName)}:nth-of-type(${index})`);
    node = parent;
  }
  return steps.length ? `body > ${steps.join(' > ')}` : 'body';
}

function identityAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const name of IDENTITY_ATTRS) {
    const value = el.getAttribute(name);
    if (!value || value.length > LIMITS.anchorAttrValue) continue;
    if (name === 'id' && !stableId(value)) continue;
    attrs[name] = value;
  }
  return attrs;
}

function attrScore(expected: Record<string, string>, el: Element): number {
  const names = Object.keys(expected);
  if (names.length === 0) return 0;
  let same = 0;
  for (const name of names) if (el.getAttribute(name) === expected[name]) same++;
  return (2 * same) / names.length - (same === 0 ? 0.5 : 0);
}

function findByExactText(anchor: Anchor, doc: Document): Element | null {
  if (anchor.text.length < 3) return null;
  const candidates = doc.getElementsByTagName(anchor.tag);
  if (candidates.length > 5000) return null;
  let found: Element | null = null;
  for (const el of candidates) {
    if (elementText(el) !== anchor.text) continue;
    if (found) return null; // ambiguous: better to report "not found" than pin the wrong element
    found = el;
  }
  return found;
}

function queryAll(doc: Document, selector: string, limit: number): Element[] {
  if (!selector) return [];
  try {
    const list = doc.querySelectorAll(selector);
    return list.length > limit ? [] : Array.from(list);
  } catch {
    return [];
  }
}

function fraction(offset: number, size: number): number {
  if (!(size > 0)) return 0.5;
  return Math.round(Math.min(1, Math.max(0, offset / size)) * 1000) / 1000;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}
