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

/** A card that follows a point on a page element, or docks above the launcher when there is none. */
export function Floating(props: { tracker: Tracker; target: Target | null; label: string; children: ComponentChildren }) {
  const { tracker, target } = props;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const card = ref.current;
    if (!card || !target) return;
    const resize = new ResizeObserver(() => tracker.schedule());
    resize.observe(card);
    const untrack = tracker.track(target.element, target.point, (position) => place(card, position));
    return () => {
      untrack();
      resize.disconnect();
    };
  }, [tracker, target?.element, target?.point[0], target?.point[1]]);

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}
