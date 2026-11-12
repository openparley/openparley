import type { Comment, Member, Thread } from '@openparley/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { OverlayStore } from '../store';
import { Composer } from './Composer';
import { avatarStyle, initial, timeAgo } from './format';
import { Icon } from './icons';
import { KEYS, withKey } from './keys';

export interface ThreadCardProps {
  thread: Thread;
  store: OverlayStore;
  detached: boolean;
  /** Set when the thread was made in another environment: where. */
  madeIn: string | null;
  /** Set when the thread was made on another variant of this page (`?id=1` while on `?id=2`). */
  madeOn: { label: string; onGo: () => void } | null;
  onClose: () => void;
  onCopyLink: () => void;
  notify: (message: string, tone?: 'error') => void;
  /** Position among the threads you can step through with J/K; null when there's only this one. */
  nav: { index: number; total: number; onPrevious: () => void; onNext: () => void } | null;
}

export function ThreadCard({ thread, store, detached, madeIn, madeOn, onClose, onCopyLink, notify, nav }: ThreadCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const resolved = thread.status === 'resolved';
  const user = store.getState().user;
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    if (store.kind === 'sync') store.members().then(setMembers, () => {});
  }, [store]);
  const handles = new Set(members.map((m) => m.handle));
  const me = members.find((m) => m.id === user?.id)?.handle;

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [thread.comments.length]);

  const run = (action: () => Promise<void>) => () => action().catch((err: Error) => notify(err.message, 'error'));

  return (
    <>
      <div class="card-head">
        <span class="card-title">
          <span class="dot" data-status={thread.status} />
          <span>{resolved ? 'Resolved' : 'Open'}</span>
        </span>
        {nav && (
          <span class="stepper">
            <button
              type="button"
              class="icon-btn"
              title={withKey('Previous thread', 'previous')}
              aria-label="Previous thread"
              aria-keyshortcuts={KEYS.previous.aria}
              onClick={nav.onPrevious}
            >
              <Icon name="previous" />
            </button>
            <span class="stepper-count" aria-label={`Thread ${nav.index + 1} of ${nav.total}`}>
              {nav.index + 1} / {nav.total}
            </span>
            <button
              type="button"
              class="icon-btn"
              title={withKey('Next thread', 'next')}
              aria-label="Next thread"
              aria-keyshortcuts={KEYS.next.aria}
              onClick={nav.onNext}
            >
              <Icon name="next" />
            </button>
          </span>
        )}
        <button
          type="button"
          class="icon-btn"
          title={resolved ? 'Reopen' : 'Resolve'}
          aria-label={resolved ? 'Reopen thread' : 'Resolve thread'}
          onClick={run(() => store.setStatus(thread.id, resolved ? 'open' : 'resolved'))}
        >
          <Icon name={resolved ? 'undo' : 'check'} />
        </button>
        <button type="button" class="icon-btn" title="Copy link" aria-label="Copy link to this thread" onClick={onCopyLink}>
          <Icon name="link" />
        </button>
        {store.canDelete(thread.author) &&
          (confirmDelete ? (
            <button type="button" class="btn" data-tone="danger" autoFocus onClick={run(() => store.deleteThread(thread.id))} onBlur={() => setConfirmDelete(false)}>
              Delete
            </button>
          ) : (
            <button type="button" class="icon-btn" data-tone="danger" title="Delete thread" aria-label="Delete thread" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" />
            </button>
          ))}
        <button type="button" class="icon-btn" title={withKey('Close', 'escape')} aria-label="Close" aria-keyshortcuts={KEYS.escape.aria} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {madeIn && <p class="notice">Made on {madeIn}.</p>}
      {madeOn && (
        <p class="notice">
          Made on{' '}
          <button type="button" class="notice-link" title="Go to that page" onClick={madeOn.onGo}>
            {madeOn.label.length > 80 ? `${madeOn.label.slice(0, 79)}…` : madeOn.label}
          </button>
          .
        </p>
      )}
      {detached && <p class="notice">The element this thread was attached to isn't on the page anymore.</p>}
      <div class="comments" ref={listRef}>
        {thread.comments.map((comment) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            handles={handles}
            me={me}
            canDelete={thread.comments.length > 1 && store.canDelete(comment.author)}
            onDelete={run(() => store.deleteComment(thread.id, comment.id))}
          />
        ))}
      </div>
      <Composer
        placeholder={resolved ? 'Reply (keeps it resolved)' : 'Reply'}
        submitLabel="Reply"
        askName={store.kind === 'local' && !user?.name}
        onEscape={onClose}
        members={store.kind === 'sync' ? store.members : undefined}
        onSubmit={async (body, name) => {
          if (store.kind === 'local' && name) store.setName(name);
          await store.addComment(thread.id, body);
        }}
      />
    </>
  );
}

function CommentRow({
  comment,
  handles,
  me,
  canDelete,
  onDelete,
}: {
  comment: Comment;
  handles: Set<string>;
  me: string | undefined;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const { agent, author } = comment;
  return (
    <div class="comment">
      <span class="avatar" data-agent={agent ? '' : undefined} style={avatarStyle(author.id)} aria-hidden="true">
        {initial(agent ?? author.name)}
      </span>
      <div class="comment-main">
        <div class="comment-meta">
          <span class="comment-author">{agent ?? author.name}</span>
          {agent && (
            <span class="comment-agent" title={`${agent}, an agent acting for ${author.name}`}>
              agent · {author.name.split(' ')[0]}
            </span>
          )}
          <time class="comment-time" dateTime={new Date(comment.createdAt).toISOString()} title={new Date(comment.createdAt).toLocaleString()}>
            {timeAgo(comment.createdAt)}
          </time>
          {canDelete && (
            <button type="button" class="icon-btn comment-delete" data-tone="danger" aria-label="Delete comment" title="Delete comment" onClick={onDelete}>
              <Icon name="trash" />
            </button>
          )}
        </div>
        <p class="comment-body">
          <Mentions text={comment.body} handles={handles} me={me} />
        </p>
      </div>
    </div>
  );
}

/** Highlights `@handle` of current members, Slack-style; yours stands out. Still plain text nodes, never HTML. */
function Mentions({ text, handles, me }: { text: string; handles: Set<string>; me: string | undefined }) {
  const parts = text.split(/(@[\w.-]+)/);
  return (
    <>
      {parts.map((part, i) => {
        const handle = part.slice(1).replace(/[.-]+$/, '');
        if (i % 2 === 0 || /\w$/.test(parts[i - 1]!) || !handles.has(handle.toLowerCase())) return part;
        return (
          <>
            <span class="mention" data-me={handle.toLowerCase() === me ? '' : undefined}>
              @{handle}
            </span>
            {part.slice(handle.length + 1)}
          </>
        );
      })}
    </>
  );
}
