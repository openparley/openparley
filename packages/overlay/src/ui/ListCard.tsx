import type { Thread } from '@openparley/protocol';
import { sameVariant, variantOf, type PageRef } from '../page';
import { avatarStyle, environmentLabel, initial, plural, timeAgo } from './format';
import { Icon } from './icons';
import { KEYS, withKey } from './keys';

export interface ListCardProps {
  /** Every page in this environment. */
  threads: Thread[];
  /** This page, other environments. */
  elsewhere: Thread[];
  here: PageRef;
  located: (thread: Thread) => boolean;
  showResolved: boolean;
  onShowResolved: (show: boolean) => void;
  onOpen: (thread: Thread) => void;
  onClose: () => void;
}

export function ListCard({ threads, elsewhere, here, located, showResolved, onShowResolved, onOpen, onClose }: ListCardProps) {
  const visible = threads.filter((t) => showResolved || t.status === 'open');
  const resolvedCount = threads.length - threads.filter((t) => t.status === 'open').length;
  const others = elsewhere.filter((t) => showResolved || t.status === 'open');
  const groups = groupByPage(visible, here.page);

  const item = (thread: Thread, where?: string) => {
    const first = thread.comments[0];
    const replies = thread.comments.length - 1;
    const variant = variantOf(thread);
    return (
      <li key={thread.id}>
        <button type="button" class="list-item" onClick={() => onOpen(thread)}>
          <span class="avatar" style={avatarStyle(thread.author.id)} aria-hidden="true">
            {initial(thread.author.name)}
          </span>
          <span class="list-text">
            <p class="list-body">{first?.body}</p>
            <span class="list-meta">
              {where ? `${where} · ` : ''}
              {!where && variant && variant !== variantOf(here) ? <span class="list-variant">{variant} · </span> : ''}
              {thread.author.name} · {timeAgo(thread.createdAt)}
              {replies > 0 && ` · ${plural(replies, 'reply', 'replies')}`}
              {thread.status === 'resolved' && ' · resolved'}
              {!where && sameVariant(thread, here) && !located(thread) && ' · element not found'}
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <>
      <div class="card-head">
        <span class="card-title">Threads</span>
        <button type="button" class="icon-btn" aria-label="Close list" title={withKey('Close', 'escape')} aria-keyshortcuts={KEYS.escape.aria} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div class="list">
        {visible.length === 0 && (
          <p class="empty">{threads.length ? 'All threads are resolved.' : elsewhere.length ? 'No threads in this environment yet.' : 'No threads yet.'}</p>
        )}
        {groups.map(([page, list]) => (
          <section key={page} aria-label={page === here.page ? `This page, ${page}` : page}>
            <p class="list-section">
              <span class="list-path">{page}</span>
              {page === here.page && <span class="list-here">This page</span>}
            </p>
            <ul>{list.map((thread) => item(thread))}</ul>
          </section>
        ))}
        {others.length > 0 && (
          <section aria-label="Other environments">
            <p class="list-section">Other environments</p>
            <ul>{others.map((thread) => item(thread, environmentLabel(thread.environment!)))}</ul>
          </section>
        )}
      </div>
      <label class="toggle">
        <input type="checkbox" checked={showResolved} onChange={(e) => onShowResolved(e.currentTarget.checked)} />
        Show resolved ({resolvedCount})
      </label>
    </>
  );
}

/** This page first, then the other pages by latest activity. Threads within a page stay oldest first. */
export function groupByPage(threads: Thread[], current: string): [string, Thread[]][] {
  const groups = new Map<string, Thread[]>();
  for (const thread of threads) groups.set(thread.page, [...(groups.get(thread.page) ?? []), thread]);
  const activity = (list: Thread[]) => Math.max(...list.map((t) => t.comments.at(-1)?.createdAt ?? t.createdAt));
  return [...groups].sort(([a, x], [b, y]) => Number(b === current) - Number(a === current) || activity(y) - activity(x));
}
