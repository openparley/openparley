// A finger that wanders this far is dragging, not tapping (browsers use a similar slop).
const SLOP = 10;

export interface TouchTap {
  x: number;
  y: number;
  target: EventTarget | null;
  /** Composed path at touch start, so callers can tell taps on the overlay from taps on the page. */
  path: EventTarget[];
}

/**
 * Follows the primary touch pointer and reports it at `touchend` if it was a tap. Scrolling makes
 * the browser cancel the pointer, so a scroll never counts; a finger that moved more than SLOP
 * doesn't either. Mouse and pen are ignored. The decision is made at `touchend` because that's
 * the last moment its click can still be cancelled. Register before any listener that stops
 * pointerdown propagation on window.
 */
export function onTouchTap(handler: (tap: TouchTap, end: TouchEvent) => void): () => void {
  let tap: TouchTap | null = null;
  const down = (event: PointerEvent) => {
    tap = event.pointerType === 'touch' && event.isPrimary
      ? { x: event.clientX, y: event.clientY, target: event.target, path: event.composedPath() }
      : null;
  };
  const move = (event: PointerEvent) => {
    if (tap && event.pointerType === 'touch' && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > SLOP) tap = null;
  };
  const cancel = () => (tap = null);
  const end = (event: TouchEvent) => {
    const ended = tap;
    if (event.touches.length === 0) tap = null;
    if (ended && event.touches.length === 0) handler(ended, event);
  };

  const passive = { capture: true, passive: true };
  window.addEventListener('pointerdown', down, passive);
  window.addEventListener('pointermove', move, passive);
  window.addEventListener('pointercancel', cancel, passive);
  window.addEventListener('touchend', end, { capture: true, passive: false });
  return () => {
    window.removeEventListener('pointerdown', down, passive);
    window.removeEventListener('pointermove', move, passive);
    window.removeEventListener('pointercancel', cancel, passive);
    window.removeEventListener('touchend', end, { capture: true });
  };
}
