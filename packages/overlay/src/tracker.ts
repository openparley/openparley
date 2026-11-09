export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TrackedPosition {
  /** Viewport coordinates of the anchored point. */
  x: number;
  y: number;
  /** False when the element is gone, has no box, or the point is clipped by a scroll container. */
  visible: boolean;
  /** The element's visible box: its rect cut down to any clipping scroll containers. Null when nothing shows. */
  box: Box | null;
}

interface Item {
  element: Element;
  point: readonly [number, number];
  clips: Element[];
  apply: (position: TrackedPosition) => void;
}

const SAFETY_POLL_MS = 300;
const DOM_CHANGE_THROTTLE_MS = 250;

/**
 * Keeps overlay elements glued to page elements. All layout reads happen in one
 * animation frame and results are written straight to the DOM, so scrolling never
 * triggers a UI re-render.
 */
export class Tracker {
  private items = new Set<Item>();
  private frame = 0;
  private domListeners = new Set<() => void>();
  private domTimer: ReturnType<typeof setTimeout> | undefined;
  private lastDomNotify = 0;
  private readonly poll: ReturnType<typeof setInterval>;
  private readonly resizeObserver = new ResizeObserver(() => this.schedule());
  private readonly mutationObserver = new MutationObserver(() => this.onMutation());

  constructor() {
    window.addEventListener('scroll', this.schedule, { capture: true, passive: true });
    window.addEventListener('resize', this.schedule, { passive: true });
    this.mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    // CSS transitions and animations move elements without firing any event we can hear.
    this.poll = setInterval(() => {
      if (this.items.size) this.schedule();
    }, SAFETY_POLL_MS);
  }

  track(element: Element, point: readonly [number, number], apply: (position: TrackedPosition) => void): () => void {
    const item: Item = { element, point, apply, clips: clippingAncestors(element) };
    this.items.add(item);
    this.resizeObserver.observe(element);
    item.apply(measure(item));
    return () => {
      this.items.delete(item);
      if (![...this.items].some((other) => other.element === element)) this.resizeObserver.unobserve(element);
    };
  }

  /** Throttled notification that the page DOM changed (used to re-resolve anchors). */
  onDomChange(listener: () => void): () => void {
    this.domListeners.add(listener);
    return () => this.domListeners.delete(listener);
  }

  schedule = (): void => {
    if (!this.frame) this.frame = requestAnimationFrame(this.flush);
  };

  destroy(): void {
    cancelAnimationFrame(this.frame);
    clearInterval(this.poll);
    clearTimeout(this.domTimer);
    this.resizeObserver.disconnect();
    this.mutationObserver.disconnect();
    window.removeEventListener('scroll', this.schedule, { capture: true });
    window.removeEventListener('resize', this.schedule);
    this.items.clear();
    this.domListeners.clear();
  }

  private flush = (): void => {
    this.frame = 0;
    const results: [Item, TrackedPosition][] = [];
    for (const item of this.items) results.push([item, measure(item)]);
    for (const [item, position] of results) item.apply(position);
  };

  private onMutation(): void {
    this.schedule();
    if (this.domTimer) return;
    const wait = Math.max(0, DOM_CHANGE_THROTTLE_MS - (Date.now() - this.lastDomNotify));
    this.domTimer = setTimeout(() => {
      this.domTimer = undefined;
      this.lastDomNotify = Date.now();
      for (const listener of this.domListeners) listener();
    }, wait);
  }
}

function measure(item: Item): TrackedPosition {
  const { element, point, clips } = item;
  if (!element.isConnected) return { x: 0, y: 0, visible: false, box: null };
  const rect = element.getBoundingClientRect();
  const x = rect.left + point[0] * rect.width;
  const y = rect.top + point[1] * rect.height;
  if (rect.width === 0 && rect.height === 0) return { x, y, visible: false, box: null };
  let { left, top, right, bottom } = rect;
  let visible = true;
  for (const clip of clips) {
    const edge = clip.getBoundingClientRect();
    if (x < edge.left || x > edge.right || y < edge.top || y > edge.bottom) visible = false;
    left = Math.max(left, edge.left);
    top = Math.max(top, edge.top);
    right = Math.min(right, edge.right);
    bottom = Math.min(bottom, edge.bottom);
  }
  const box = right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
  return { x, y, visible, box };
}

function clippingAncestors(element: Element): Element[] {
  const clips: Element[] = [];
  const root = element.ownerDocument.documentElement;
  for (let node = element.parentElement; node && node !== root && node !== element.ownerDocument.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') clips.push(node);
  }
  return clips;
}
