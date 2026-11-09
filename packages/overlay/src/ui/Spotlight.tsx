import { useLayoutEffect, useRef } from 'preact/hooks';
import type { Tracker } from '../tracker';

// Generous room around a discussed element; tight while picking so the target stays unambiguous.
const PADDING = { focus: 16, pick: 6 } as const;
const MOVE_MS = 280;

/**
 * Dims the page except for a rounded cutout around `element`. Glides when it moves to a different
 * element, but follows scrolling instantly (a transition there would make it trail behind).
 */
export function Spotlight(props: { tracker: Tracker; element: Element; label?: string; variant?: 'pick' }) {
  const { tracker, element } = props;
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<Element | null>(null);

  useLayoutEffect(() => {
    const spot = ref.current;
    if (!spot) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (previous.current && previous.current !== element) {
      spot.dataset.moving = '';
      timer = setTimeout(() => delete spot.dataset.moving, MOVE_MS);
    }
    previous.current = element;
    const padding = PADDING[props.variant ?? 'focus'];
    const untrack = tracker.track(element, [0, 0], ({ box }) => {
      spot.hidden = !box;
      if (!box) return;
      spot.style.translate = `${Math.round(box.left - padding)}px ${Math.round(box.top - padding)}px`;
      spot.style.width = `${Math.round(box.width + 2 * padding)}px`;
      spot.style.height = `${Math.round(box.height + 2 * padding)}px`;
    });
    return () => {
      clearTimeout(timer);
      untrack();
    };
  }, [tracker, element, props.variant]);

  return (
    <div ref={ref} class="spotlight" data-variant={props.variant} aria-hidden="true">
      {props.label && <span class="spotlight-label">{props.label}</span>}
    </div>
  );
}
