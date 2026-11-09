import type { Anchor, Thread } from '@openparley/protocol';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createAnchor, resolveAnchor, type Match } from '../anchor';
import { pageKey, watchNavigation } from '../page';
import { refLink, stripShareHash, threadsLink, type SharePayload } from '../share';
import type { OverlayStore, StoreState } from '../store';
import { listenForShortcut, type ShortcutPriority } from '../shortcut';
import type { Tracker } from '../tracker';
import { Composer } from './Composer';
import { Floating, isSheet } from './Floating';
import { copyText, describeElement, environmentLabel } from './format';
import { KEYS } from './keys';
import { Launcher, type LauncherProps } from './Launcher';
import { ListCard } from './ListCard';
import { Picker } from './Picker';
import { DraftPin, Pin } from './Pin';
import { Spotlight } from './Spotlight';
import { onTouchTap } from './tap';
import { ThreadCard } from './ThreadCard';

export type View =
  | { name: 'closed' }
  | { name: 'browse' }
  | { name: 'pick' }
  | { name: 'compose'; element: Element; anchor: Anchor }
  | { name: 'thread'; id: string };

interface Toast {
  message: string;
  tone?: 'error';
  key: number;
}

export interface AppProps {
  host: HTMLElement;
  store: OverlayStore;
  tracker: Tracker;
  share: Promise<SharePayload | null>;
  startActive: boolean;
  onActiveChange: (active: boolean) => void;
  /** Global key that starts a new thread, or null when disabled. */
  shortcut: string | null;
  shortcutPriority: ShortcutPriority;
}

const BROWSE: View = { name: 'browse' };
const CLOSED: View = { name: 'closed' };

export function App({ host, store, tracker, share, startActive, onActiveChange, shortcut, shortcutPriority }: AppProps) {
  const state = useStoreState(store);
  const [page, setPage] = useState(pageKey);
  const [view, setView] = useState<View>(startActive ? BROWSE : CLOSED);
  const [listOpen, setListOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<Element | null>(null);
  // Decided by the last pointer, not the device: touchscreen laptops have a mouse too.
  const [touch, setTouch] = useState(() => matchMedia('(hover: none)').matches);
  const scrollTo = useRef<string | null>(null);

  const active = view.name !== 'closed';
  const openId = view.name === 'thread' ? view.id : null;
  // A thread from another environment is only placed on the page while it's open.
  const fromElsewhere = openId ? state.elsewhere.find((t) => t.id === openId) : undefined;
  const placed = useMemo(() => (fromElsewhere ? [...state.threads, fromElsewhere] : state.threads), [state.threads, fromElsewhere]);
  const resolutions = useResolutions(placed, tracker, active);
  const selected = openId ? (state.threads.find((t) => t.id === openId) ?? fromElsewhere) : undefined;

  const notify = useCallback((message: string, tone?: 'error') => setToast({ message, tone, key: Date.now() }), []);

  useEffect(() => watchNavigation(() => setPage(pageKey())), []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => setTouch(event.pointerType === 'touch');
    window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    return () => window.removeEventListener('pointerdown', onPointerDown, { capture: true });
  }, []);

  // Only a real navigation resets the view; on mount this must not undo a shortcut pressed early.
  const shownPage = useRef(page);
  useEffect(() => {
    store.setPage(page);
    if (shownPage.current === page) return;
    shownPage.current = page;
    setView((v) => (v.name === 'closed' ? v : BROWSE));
  }, [store, page]);

  useEffect(() => onActiveChange(active), [active]);

  useEffect(() => {
    if (state.error) notify(state.error, 'error');
  }, [state.error]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.tone === 'error' ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  // Links: `#parley=` is consumed once, then removed so a reload doesn't re-import it.
  useEffect(() => {
    let cancelled = false;
    void share.then((payload) => {
      if (cancelled || !payload) return;
      history.replaceState(history.state, '', location.pathname + location.search + stripShareHash(location.hash));
      if (payload.kind === 'threads') {
        if (store.kind !== 'local') {
          notify('This link holds threads saved in a browser, but this site uses a team server. Ask the sender to post them there.', 'error');
          return;
        }
        const [first] = store.importThreads(payload.threads);
        if (!first) return;
        setView(BROWSE);
        if (first.page === pageKey()) setFocusId(first.id);
        else notify(`The shared thread is on another page: ${first.page}`);
      } else {
        if (store.kind !== 'sync') {
          notify("This link points to a team thread, but this site isn't connected to a team server.", 'error');
          return;
        }
        setView(BROWSE);
        setFocusId(payload.threadId);
        if (store.getState().status === 'signed-out') notify('Sign in to see the thread that was shared with you.');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!focusId || state.status !== 'ready') return;
    setFocusId(null);
    if (state.threads.some((t) => t.id === focusId) || state.elsewhere.some((t) => t.id === focusId)) {
      openThread(focusId);
      return;
    }
    if (store.kind === 'sync') {
      store
        .fetchThread(focusId)
        .then((thread) => notify(thread ? `The shared thread is on another page: ${thread.page}` : 'The shared thread no longer exists.'))
        .catch((err: Error) => notify(err.message, 'error'));
    }
  }, [focusId, state.status, state.threads]);

  // Scroll a freshly opened thread into view as soon as its element can be found.
  useEffect(() => {
    const id = scrollTo.current;
    if (!id) return;
    if (view.name !== 'thread' || view.id !== id) {
      scrollTo.current = null;
      return;
    }
    const match = resolutions.get(id);
    if (match) {
      scrollTo.current = null;
      // A bottom sheet would cover the centre; Floating scrolls the element clear of it instead.
      if (!isSheet()) match.element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [resolutions, view]);

  useEffect(() => {
    if (view.name === 'thread' && state.status === 'ready' && !selected) setView(BROWSE);
  }, [view, selected, state.status]);

  // Clicking anywhere on the page closes an open thread or an unsent new thread. A finger only
  // closes it with a tap: touching the page to scroll must keep the draft.
  useEffect(() => {
    if (view.name !== 'thread' && view.name !== 'compose') return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && !event.composedPath().includes(host)) setView(BROWSE);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    const stopTaps = onTouchTap((tap) => {
      if (!tap.path.includes(host)) setView(BROWSE);
    });
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      stopTaps();
    };
  }, [view.name, host]);

  const canCreate = state.status === 'ready' && state.user !== null;

  // Registered once and fed live state through a ref, so no keypress is lost between re-renders.
  // Threads you can step through with J/K: the visible ones in reading order (top to bottom, then
  // left to right on the page); ones whose element is gone come last.
  function stepOrder(): Thread[] {
    const visible = state.threads.filter((t) => showResolved || t.status === 'open' || t.id === selected?.id);
    const placed: { thread: Thread; x: number; y: number }[] = [];
    const missing: Thread[] = [];
    for (const thread of visible) {
      const match = resolutions.get(thread.id);
      if (!match) {
        missing.push(thread);
        continue;
      }
      const rect = match.element.getBoundingClientRect();
      placed.push({
        thread,
        x: rect.left + scrollX + thread.anchor.point[0] * rect.width,
        y: rect.top + scrollY + thread.anchor.point[1] * rect.height,
      });
    }
    placed.sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
    return [...placed.map((p) => p.thread), ...missing];
  }

  function step(delta: 1 | -1) {
    const order = stepOrder();
    if (order.length === 0) return;
    const index = selected ? order.findIndex((t) => t.id === selected.id) : -1;
    const next = index === -1 ? order[delta === 1 ? 0 : order.length - 1]! : order[(index + delta + order.length) % order.length]!;
    if (next.id !== selected?.id) openThread(next.id);
  }

  const keyState = useRef({ active, view, listOpen, canCreate, step });
  keyState.current = { active, view, listOpen, canCreate, step };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { active, view, listOpen, step } = keyState.current;
      if (!active || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditable(event.composedPath()[0])) return;
      if (event.key === 'Escape') {
        if (view.name !== 'browse') setView(BROWSE);
        else if (listOpen) setListOpen(false);
        else setView(CLOSED);
      } else if ((event.key === 'j' || event.key === 'k') && (view.name === 'browse' || view.name === 'thread')) {
        event.preventDefault();
        step(event.key === 'j' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Works with the overlay closed too. Never discards a draft or restarts an ongoing pick.
  // Layout effect: live as soon as the launcher is on screen (useEffect waits until after paint).
  useLayoutEffect(() => {
    if (!shortcut) return;
    return listenForShortcut({
      key: shortcut,
      priority: shortcutPriority,
      host,
      onTrigger: () => {
        const { view, canCreate } = keyState.current;
        if (view.name === 'pick' || view.name === 'compose') return;
        setListOpen(false);
        if (canCreate) setView({ name: 'pick' });
        else if (view.name === 'closed') setView(BROWSE);
      },
    });
  }, [shortcut, shortcutPriority, host]);

  function openThread(id: string) {
    scrollTo.current = id;
    setListOpen(false);
    setView({ name: 'thread', id });
  }

  function startPicking() {
    setListOpen(false);
    setView({ name: 'pick' });
  }

  async function copyLink(thread: Thread) {
    const base = new URL(location.href);
    const link = store.kind === 'sync' ? refLink(base, thread.id) : await threadsLink(base, [thread]);
    if (await copyText(link)) {
      notify(store.kind === 'sync' ? 'Link copied.' : 'Link copied. It contains the conversation so far.');
    } else {
      notify("Couldn't access the clipboard. Copy the link from the address bar instead.", 'error');
      history.replaceState(history.state, '', link);
    }
  }

  const located = (thread: Thread) => !!resolutions.get(thread.id);

  // One spotlight for whatever is in focus, so it glides from the hovered element to the open thread.
  let spotlight: { element: Element; variant?: 'pick' } | null = null;
  if (view.name === 'pick' && hovered) spotlight = { element: hovered, variant: 'pick' };
  else if (view.name === 'compose') spotlight = { element: view.element };
  else if (selected && resolutions.get(selected.id)) spotlight = { element: resolutions.get(selected.id)!.element };
  const openCount = state.threads.filter((t) => t.status === 'open').length;

  let primary: LauncherProps['primary'] = null;
  if (store.kind === 'sync' && state.status === 'signed-out') {
    primary = { label: 'Sign in', onClick: () => void store.signIn().catch((err: Error) => notify(err.message, 'error')) };
  } else if (state.status === 'loading') {
    primary = { label: 'Connecting…', onClick: () => {}, disabled: true };
  } else if (view.name === 'pick') {
    primary = { label: 'Cancel', onClick: () => setView(BROWSE), key: { label: KEYS.escape.label, aria: KEYS.escape.aria } };
  } else if (canCreate) {
    const key = shortcut?.toUpperCase();
    primary = { label: 'Comment', onClick: startPicking, key: key ? { label: key, aria: key } : undefined };
  }

  return (
    <>
      {spotlight && (
        <Spotlight
          tracker={tracker}
          element={spotlight.element}
          variant={spotlight.variant}
          label={spotlight.variant === 'pick' ? describeElement(spotlight.element) : undefined}
        />
      )}

      {active &&
        placed.map((thread) => {
          const match = resolutions.get(thread.id);
          const isSelected = selected?.id === thread.id;
          if (!match || (thread.status === 'resolved' && !showResolved && !isSelected)) return null;
          return (
            <Pin
              key={thread.id}
              tracker={tracker}
              element={match.element}
              thread={thread}
              active={isSelected}
              onOpen={() => (isSelected ? setView(BROWSE) : openThread(thread.id))}
            />
          );
        })}

      {view.name === 'pick' && (
        <Picker
          host={host}
          touch={touch}
          onHover={setHovered}
          onPick={(element, x, y) => setView({ name: 'compose', element, anchor: createAnchor(element, x, y) })}
        />
      )}

      {view.name === 'compose' && (
        <>
          <DraftPin tracker={tracker} element={view.element} point={view.anchor.point} />
          <Floating tracker={tracker} target={{ element: view.element, point: view.anchor.point }} label="New thread">
            <Composer
              placeholder="What's on your mind about this?"
              submitLabel="Post"
              askName={store.kind === 'local' && !state.user?.name}
              autoFocus
              members={store.kind === 'sync' ? store.members : undefined}
              onCancel={() => setView(BROWSE)}
              onSubmit={async (body, name) => {
                if (store.kind === 'local' && name) store.setName(name);
                const thread = await store.createThread(page, view.anchor, body);
                setView({ name: 'thread', id: thread.id });
              }}
            />
          </Floating>
        </>
      )}

      {selected && (
        <Floating
          tracker={tracker}
          target={resolutions.get(selected.id) ? { element: resolutions.get(selected.id)!.element, point: selected.anchor.point } : null}
          label="Thread"
        >
          <ThreadCard
            nav={(() => {
              const order = stepOrder();
              const index = order.findIndex((t) => t.id === selected.id);
              return order.length > 1 && index !== -1
                ? { index, total: order.length, onPrevious: () => step(-1), onNext: () => step(1) }
                : null;
            })()}
            thread={selected}
            store={store}
            detached={!resolutions.get(selected.id)}
            madeIn={fromElsewhere?.environment ? environmentLabel(fromElsewhere.environment) : null}
            onClose={() => setView(BROWSE)}
            onCopyLink={() => void copyLink(selected)}
            notify={notify}
          />
        </Floating>
      )}

      {active && listOpen && view.name !== 'thread' && (
        <Floating tracker={tracker} target={null} label="Threads on this page">
          <ListCard
            threads={state.threads}
            elsewhere={state.elsewhere}
            located={located}
            showResolved={showResolved}
            onShowResolved={setShowResolved}
            onOpen={(thread) => openThread(thread.id)}
            onClose={() => setListOpen(false)}
          />
        </Floating>
      )}

      {toast && (
        <div class="toast" key={toast.key} role={toast.tone === 'error' ? 'alert' : 'status'} data-tone={toast.tone}>
          {toast.message}
        </div>
      )}

      <Launcher
        active={active}
        openCount={openCount}
        listOpen={listOpen && view.name !== 'thread'}
        picking={view.name === 'pick'}
        primary={primary}
        onActivate={() => setView(BROWSE)}
        onDeactivate={() => {
          setListOpen(false);
          setView(CLOSED);
        }}
        onToggleList={() => {
          if (view.name !== 'browse') setView(BROWSE);
          setListOpen(view.name === 'browse' ? !listOpen : true);
        }}
        onSignOut={store.kind === 'sync' && state.user ? () => void store.signOut() : null}
      />
    </>
  );
}

function useStoreState(store: OverlayStore): StoreState {
  const [state, setState] = useState(store.getState());
  useEffect(() => {
    setState(store.getState());
    return store.subscribe(() => setState(store.getState()));
  }, [store]);
  return state;
}

/** Locates each thread's element; re-runs when threads or the page DOM change. Keeps identity when nothing moved. */
function useResolutions(threads: Thread[], tracker: Tracker, enabled: boolean): Map<string, Match | null> {
  const [domVersion, setDomVersion] = useState(0);
  const previous = useRef(new Map<string, Match | null>());

  useEffect(() => {
    if (!enabled) return;
    return tracker.onDomChange(() => setDomVersion((v) => v + 1));
  }, [tracker, enabled]);

  return useMemo(() => {
    const next = new Map<string, Match | null>();
    if (enabled) for (const thread of threads) next.set(thread.id, resolveAnchor(thread.anchor));
    if (sameResolutions(previous.current, next)) return previous.current;
    previous.current = next;
    return next;
  }, [threads, domVersion, enabled]);
}

function sameResolutions(a: Map<string, Match | null>, b: Map<string, Match | null>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, match] of b) {
    const other = a.get(id);
    if (other === undefined && !a.has(id)) return false;
    if ((other?.element ?? null) !== (match?.element ?? null) || other?.exact !== match?.exact) return false;
  }
  return true;
}

function isEditable(target: EventTarget | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
