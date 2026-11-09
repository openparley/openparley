import { useEffect, useRef } from 'preact/hooks';
import { onTouchTap } from './tap';

const BLOCKED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick'] as const;
// Passive, so scrolling stays smooth: the page just doesn't hear about touches while picking.
const TOUCHES = ['touchstart', 'touchend'] as const;

// The native cursor is hidden and a real pin follows the pointer instead: image cursors are
// drawn inconsistently across browsers (blurry on retina, fallbacks, stale shapes). The pin's
// pointed bottom-left corner is the hotspot, exactly where it lands after the click.
const HIDE_CURSOR = `*:not(${'openparley-overlay'}){cursor:none!important}`;

/**
 * Element picking mode: reports whatever is under the pointer (the App spotlights it) and
 * captures the next click instead of letting the page handle it. Touch has no hover, so there the
 * first tap highlights an element and a second tap on it picks it.
 */
export function Picker(props: {
  host: HTMLElement;
  /** The last pointer was a finger: changes the hint. */
  touch: boolean;
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
    const elementOf = (target: EventTarget | null): Element | null => {
      let el = target instanceof Element ? target : null;
      // Pin to the whole icon rather than an individual <path> inside it.
      while (el instanceof SVGElement && el.ownerSVGElement) el = el.ownerSVGElement;
      return el && el !== document.body && el !== document.documentElement ? el : null;
    };

    const targetOf = (event: Event) => elementOf(event.target);

    // Taps are decided at touchend, whose preventDefault() also cancels the click (and on iOS a
    // double-tap zoom). Pointer events alone can't do that, and iOS doesn't reliably click
    // non-interactive elements. Registered first: `block` stops pointerdown for later listeners.
    const stopTaps = onTouchTap((tap, end) => {
      if (tap.path.includes(host)) return;
      end.preventDefault();
      end.stopImmediatePropagation();
      const target = elementOf(tap.target);
      if (!target) return;
      if (target === current) return handlers.current.onPick(target, tap.x, tap.y);
      current = target;
      handlers.current.onHover(target);
    });

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
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
      // Touch picks on touchend; a click still arriving from a finger (one that moved a little) must not pick.
      if ((event as PointerEvent).pointerType === 'touch') return;
      const target = targetOf(event);
      if (target) handlers.current.onPick(target, event.clientX, event.clientY);
    };

    const stopForPage = (event: Event) => {
      if (!ours(event)) event.stopImmediatePropagation();
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
    for (const type of TOUCHES) window.addEventListener(type, stopForPage, { capture: true, passive: true });
    return () => {
      stopTaps();
      for (const type of TOUCHES) window.removeEventListener(type, stopForPage, { capture: true });
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
        {props.touch ? 'Tap an element, tap again to start a thread' : 'Click an element to start a thread · Esc to cancel'}
      </div>
    </>
  );
}
