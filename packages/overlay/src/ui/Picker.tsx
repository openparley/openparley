import { useEffect, useRef } from 'preact/hooks';

const BLOCKED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick'] as const;

// The native cursor is hidden and a real pin follows the pointer instead: image cursors are
// drawn inconsistently across browsers (blurry on retina, fallbacks, stale shapes). The pin's
// pointed bottom-left corner is the hotspot, exactly where it lands after the click.
const HIDE_CURSOR = `*:not(${'openparley-overlay'}){cursor:none!important}`;

/**
 * Element picking mode: reports whatever is under the pointer (the App spotlights it) and
 * captures the next click instead of letting the page handle it.
 */
export function Picker(props: {
  host: HTMLElement;
  onHover: (element: Element | null) => void;
  onPick: (element: Element, x: number, y: number) => void;
}) {
  const handlers = useRef(props);
  handlers.current = props;
  const pinRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const { host } = props;
    let current: Element | null = null;

    const ours = (event: Event) => event.composedPath().includes(host);
    const targetOf = (event: Event): Element | null => {
      let el = event.target instanceof Element ? event.target : null;
      // Pin to the whole icon rather than an individual <path> inside it.
      while (el instanceof SVGElement && el.ownerSVGElement) el = el.ownerSVGElement;
      return el && el !== document.body && el !== document.documentElement ? el : null;
    };

    const onMove = (event: PointerEvent) => {
      const pin = pinRef.current;
      if (pin) {
        pin.hidden = ours(event);
        pin.style.translate = `${event.clientX}px ${event.clientY}px`;
      }
      const next = ours(event) ? null : targetOf(event);
      if (next === current) return;
      current = next;
      handlers.current.onHover(next);
    };
    const block = (event: Event) => {
      if (ours(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onClick = (event: MouseEvent) => {
      if (ours(event)) return;
      block(event);
      const target = targetOf(event);
      if (target) handlers.current.onPick(target, event.clientX, event.clientY);
    };

    const onLeave = (event: PointerEvent) => {
      if (!event.relatedTarget && pinRef.current) pinRef.current.hidden = true;
    };

    const cursor = document.createElement('style');
    cursor.textContent = HIDE_CURSOR;
    document.head.append(cursor);
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    document.addEventListener('pointerout', onLeave, true);
    window.addEventListener('click', onClick, true);
    for (const type of BLOCKED) window.addEventListener(type, block, true);
    return () => {
      cursor.remove();
      handlers.current.onHover(null);
      window.removeEventListener('pointermove', onMove, { capture: true });
      document.removeEventListener('pointerout', onLeave, true);
      window.removeEventListener('click', onClick, true);
      for (const type of BLOCKED) window.removeEventListener(type, block, true);
    };
  }, [props.host]);

  return (
    <>
      {/* Hidden until the first pointer move: before that we don't know where the pointer is. */}
      <div ref={pinRef} class="pin" data-draft="" data-cursor="" hidden aria-hidden="true" />
      <div class="pick-hint" role="status">
        Click an element to start a thread · Esc to cancel
      </div>
    </>
  );
}
