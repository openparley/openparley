import type { Thread } from '@openparley/protocol';
import { avatarStyle, environmentLabel, initial, plural, timeAgo } from './format';
import { Icon } from './icons';
import { KEYS, withKey } from './keys';

export interface ListCardProps {
  threads: Thread[];
  /** Same page, other environments. */
  elsewhere: Thread[];
  located: (thread: Thread) => boolean;
  showResolved: boolean;
  onShowResolved: (show: boolean) => void;
  onOpen: (thread: Thread) => void;
  onClose: () => void;
}

export function ListCard({ threads, elsewhere, located, showResolved, onShowResolved, onOpen, onClose }: ListCardProps) {
  const visible = threads.filter((t) => showResolved || t.status === 'open');
  const resolvedCount = threads.length - threads.filter((t) => t.status === 'open').length;
  const others = elsewhere.filter((t) => showResolved || t.status === 'open');
  const item = (thread: Thread, where?: string) => {
    const first = thread.comments[0];
    const replies = thread.comments.length - 1;
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
              {thread.author.name} · {timeAgo(thread.createdAt)}
              {replies > 0 && ` · ${plural(replies, 'reply', 'replies')}`}
              {thread.status === 'resolved' && ' · resolved'}
              {!where && !located(thread) && ' · element not found'}
            </span>
          </span>
        </button>
      </li>
    );
  };
  return (
    <>
      <div class="card-head">
        <span class="card-title">Threads on this page</span>
        <button type="button" class="icon-btn" aria-label="Close list" title={withKey('Close', 'escape')} aria-keyshortcuts={KEYS.escape.aria} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {visible.length === 0 ? (
        <p class="empty">{threads.length ? 'All threads here are resolved.' : elsewhere.length ? 'No threads in this environment yet.' : 'No threads on this page yet.'}</p>
      ) : (
        <ul class="list">{visible.map((thread) => item(thread))}</ul>
      )}
      {others.length > 0 && (
        <>
          <p class="list-section">Other environments</p>
          <ul class="list">{others.map((thread) => item(thread, environmentLabel(thread.environment!)))}</ul>
        </>
      )}
      <label class="toggle">
        <input type="checkbox" checked={showResolved} onChange={(e) => onShowResolved(e.currentTarget.checked)} />
        Show resolved ({resolvedCount})
      </label>
    </>
  );
}
