import { useLayoutEffect, useRef } from 'preact/hooks';
import type { Thread } from '@openparley/protocol';
import type { Tracker } from '../tracker';
import { Icon } from './icons';

// Position goes in `translate`, not `transform`: the hover/active `scale` would otherwise
// scale the translation too and throw the pin away from its element (and the cursor).
export function Pin(props: { tracker: Tracker; element: Element; thread: Thread; active: boolean; onOpen: () => void }) {
  const { tracker, element, thread } = props;
  const [px, py] = thread.anchor.point;
  const ref = useRef<HTMLButtonElement>(null);

  useLayoutEffect(
    () =>
      tracker.track(element, [px, py], ({ x, y, visible }) => {
        const pin = ref.current;
        if (!pin) return;
        pin.hidden = !visible;
        pin.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
      }),
    [tracker, element, px, py],
  );

  const first = thread.comments[0];
  return (
    <button
      ref={ref}
      type="button"
      class="pin"
      data-status={thread.status}
      aria-expanded={props.active}
      aria-label={`${thread.status === 'resolved' ? 'Resolved thread' : 'Thread'} by ${thread.author.name}: ${first?.body.slice(0, 80) ?? ''}`}
      onClick={props.onOpen}
    >
      {thread.status === 'resolved' ? <Icon name="check" /> : thread.comments.length > 99 ? '99+' : thread.comments.length}
    </button>
  );
}

export function DraftPin(props: { tracker: Tracker; element: Element; point: readonly [number, number] }) {
  const ref = useRef<HTMLDivElement>(null);
  const { tracker, element, point } = props;
  useLayoutEffect(
    () =>
      tracker.track(element, point, ({ x, y, visible }) => {
        const pin = ref.current;
        if (!pin) return;
        pin.hidden = !visible;
        pin.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
      }),
    [tracker, element, point[0], point[1]],
  );
  return <div ref={ref} class="pin" data-draft="" aria-hidden="true" />;
}
