import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { Tracker, TrackedPosition } from '../tracker';

export interface Target {
  element: Element;
  point: readonly [number, number];
}

// Pins are 28px square and sit up and to the right of their anchor point.
const PIN_WIDTH = 28;
const PIN_HEIGHT = 28;
// Clears the spotlight's 16px padding around the element, plus breathing room.
const GAP = 22;
const MARGIN = 8;

// Must match the `@media` block for sheets in styles.css. Below it a 320px card leaves too little
// room beside anything; 600px is also where phones in portrait end and tablets begin.
const SHEET_QUERY = '(max-width: 600px)';

/** Narrow screens show cards as a bottom sheet instead of beside their element. */
export const isSheet = (): boolean => matchMedia(SHEET_QUERY).matches;

/**
 * A card that follows a point on a page element, or docks above the launcher when there is none.
 * On narrow screens it's a bottom sheet, and the page scrolls once so the element stays above it.
 */
export function Floating(props: { tracker: Tracker; target: Target | null; label: string; children: ComponentChildren }) {
  const { tracker, target } = props;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const card = ref.current;
    if (!card || !target) return;
    const resize = new ResizeObserver(() => tracker.schedule());
    resize.observe(card);
    let revealed = false;
    const untrack = tracker.track(target.element, target.point, (position) => {
      if (!isSheet()) return place(card, position);
      // Once per element: scrolling on every frame would fight the person scrolling.
      if (!revealed) revealed = reveal(card, position);
    });
    return () => {
      untrack();
      resize.disconnect();
    };
  }, [tracker, target?.element, target?.point[0], target?.point[1]]);

  // Keeps a sheet above the on-screen keyboard while one of its fields has focus. The keyboard
  // shrinks the visual viewport, not the layout viewport that position: fixed uses.
  useLayoutEffect(() => {
    const card = ref.current;
    const viewport = window.visualViewport;
    if (!card || !viewport) return;
    const lift = () => {
      const typing = card.contains((card.getRootNode() as ShadowRoot).activeElement);
      const hidden = document.documentElement.clientHeight - viewport.height - viewport.offsetTop;
      card.style.setProperty('--op-keyboard', `${typing ? Math.max(0, Math.round(hidden)) : 0}px`);
    };
    const events = [[viewport, 'resize'], [viewport, 'scroll'], [card, 'focusin'], [card, 'focusout']] as const;
    for (const [on, type] of events) on.addEventListener(type, lift);
    return () => {
      for (const [on, type] of events) on.removeEventListener(type, lift);
    };
  }, []);

  return (
    <div ref={ref} class="card" role="dialog" aria-label={props.label} data-docked={target ? undefined : ''}>
      {props.children}
    </div>
  );
}

/**
 * Puts the card beside the element (right, left, below, above) so it never hides what's being
 * discussed. Elements too big for any side (a full-width hero) get the card next to the pin instead.
 */
function place(card: HTMLElement, { x, y, box }: TrackedPosition): void {
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const fitsX = (left: number) => left >= MARGIN && left + width <= viewportWidth - MARGIN;
  const fitsY = (top: number) => top >= MARGIN && top + height <= viewportHeight - MARGIN;
  const besideTop = clamp(y - PIN_HEIGHT, MARGIN, viewportHeight - height - MARGIN);
  const underLeft = clamp(x - PIN_HEIGHT, MARGIN, viewportWidth - width - MARGIN);

  // The toolbar is fixed bottom-right; a card underneath it would hide its own buttons.
  const toolbar = (card.getRootNode() as ParentNode).querySelector('.launcher')?.getBoundingClientRect();
  const clearOfToolbar = (left: number, top: number) =>
    !toolbar ||
    left + width <= toolbar.left - MARGIN ||
    left >= toolbar.right + MARGIN ||
    top + height <= toolbar.top - MARGIN ||
    top >= toolbar.bottom + MARGIN;
  /** Cards beside the element may slide up to clear the toolbar. */
  const lift = (left: number, top: number): [number, number] =>
    clearOfToolbar(left, top) || !toolbar ? [left, top] : [left, Math.max(MARGIN, Math.min(top, toolbar.top - MARGIN - height))];

  // The pin's box (it extends right of and above its point) counts as part of what must stay visible.
  const area = box
    ? {
        left: Math.min(box.left, x),
        right: Math.max(box.left + box.width, x + PIN_WIDTH),
        top: Math.min(box.top, y - PIN_HEIGHT),
        bottom: Math.max(box.top + box.height, y),
      }
    : null;

  const options: [number, number][] = area
    ? [
        lift(area.right + GAP, besideTop),
        lift(area.left - GAP - width, besideTop),
        [underLeft, area.bottom + GAP],
        [underLeft, area.top - GAP - height],
      ]
    : [];
  const fallbackLeft = fitsX(x + PIN_WIDTH + GAP) ? x + PIN_WIDTH + GAP : x - GAP - width;
  const [left, top] = options.find(([l, t]) => fitsX(l) && fitsY(t) && clearOfToolbar(l, t)) ??
    lift(clamp(fallbackLeft, MARGIN, viewportWidth - width - MARGIN), besideTop);
  card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

/**
 * Scrolls the page so the element (or, if it's too tall, its pin) sits above the sheet.
 * Returns false while there's nothing to measure yet, so the next frame tries again.
 */
function reveal(card: HTMLElement, { y, box }: TrackedPosition): boolean {
  if (!box) return false;
  // From the layout, not getBoundingClientRect: the sheet may still be sliding in.
  const room = document.documentElement.clientHeight - card.offsetHeight;
  let top = Math.min(box.top, y - PIN_HEIGHT) - GAP;
  let bottom = Math.max(box.top + box.height, y) + GAP;
  if (bottom - top > room) [top, bottom] = [y - PIN_HEIGHT - GAP, y + GAP];
  const by = bottom > room ? bottom - room : top < 0 ? top : 0;
  if (by) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollBy({ top: by, behavior: reduce ? 'instant' : 'smooth' });
  }
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}
