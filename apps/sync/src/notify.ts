import type { Thread, ThreadStatus } from '@openparley/protocol';
import { mentionedIds } from './mentions';
import { threadPath, threadUrls } from './origins';
import type { NotifyLevel, PendingNotification, Repo, User } from './repo';

// Notifications are channel-agnostic: events are queued per recipient in the database (so a
// batch survives a restart, and Cloud closing an idle workspace), then delivered as one digest
// through every channel the recipient has switched on. Email is the first channel; Slack or
// Teams are another `Channel`, nothing else changes.

export interface DigestEvent {
  /** `thread`: the comment that started the thread. */
  kind: 'thread' | 'comment' | 'resolved' | 'reopened';
  /** The person who did it (an agent's user when `agent` is set). */
  actor: string;
  agent: string | null;
  /** Comment text; null for status changes. Plain text, never render it as HTML. */
  body: string | null;
  /** The recipient was @mentioned in it. */
  mention: boolean;
  at: number;
}

export interface DigestThread {
  id: string;
  project: string;
  page: string;
  /** Short description of the element the thread is on, e.g. `"Buy now"` or `<img>`. */
  element: string;
  status: ThreadStatus;
  /** Opens the thread on its element; null when the project lists no site we can link to. */
  url: string | null;
  events: DigestEvent[];
}

export interface Digest {
  recipient: Pick<User, 'id' | 'name' | 'email'>;
  threads: DigestThread[];
  /** Where the recipient chooses what they hear about. */
  settingsUrl: string;
}

export interface Channel {
  /** Stable key, stored with each user's on/off switch. */
  readonly id: string;
  readonly label: string;
  /** Whether a user who never touched the switch gets notifications here. */
  readonly defaultOn: boolean;
  /** Where this channel reaches the user (shown in settings), or null when it can't. */
  address(user: User): string | null;
  deliver(digest: Digest): Promise<void>;
}

export interface NotifierOptions {
  repo: Repo;
  channels: Channel[];
  publicUrl: string;
  /** A thread's notifications go out once nothing new happened in it for this long. */
  quietMs?: number;
  /** ...or once the oldest has waited this long, so a conversation that never pauses still arrives. */
  maxWaitMs?: number;
  now?: () => number;
}

const MAX_ATTEMPTS = 5;
/** Older than this, a notification is news nobody needs anymore. */
const STALE_MS = 24 * 60 * 60 * 1000;

export class Notifier {
  readonly channels: readonly Channel[];
  readonly quietMs: number;
  private readonly repo: Repo;
  private readonly maxWaitMs: number;
  private readonly settingsUrl: string;
  private readonly now: () => number;
  private delivering = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: NotifierOptions) {
    this.repo = options.repo;
    this.channels = options.channels;
    this.quietMs = options.quietMs ?? 60_000;
    this.maxWaitMs = options.maxWaitMs ?? Math.max(10 * 60_000, this.quietMs);
    this.settingsUrl = `${options.publicUrl}/admin#notifications`;
    this.now = options.now ?? Date.now;
  }

  threadCreated(threadId: string, actor: User): void {
    const thread = this.repo.findThread(threadId);
    const first = thread?.comments[0];
    if (thread && first) this.record(thread, 'comment', first.id, first.body, actor, null);
  }

  commented(threadId: string, commentId: string, actor: User, agent: string | null = null): void {
    const thread = this.repo.findThread(threadId);
    const comment = thread?.comments.find((c) => c.id === commentId);
    if (thread && comment) this.record(thread, 'comment', comment.id, comment.body, actor, agent);
  }

  statusChanged(threadId: string, status: ThreadStatus, actor: User, agent: string | null = null): void {
    const thread = this.repo.findThread(threadId);
    if (thread) this.record(thread, status === 'resolved' ? 'resolved' : 'reopened', null, null, actor, agent);
  }

  /** The channels that reach this user, given their switches. */
  channelsFor(user: User, switches: Record<string, boolean>): Channel[] {
    return this.channels.filter((channel) => (switches[channel.id] ?? channel.defaultOn) && channel.address(user) !== null);
  }

  private record(
    thread: Thread & { projectId: string },
    event: PendingNotification['event'],
    commentId: string | null,
    body: string | null,
    actor: User,
    agent: string | null,
  ): void {
    // An agent acts on its user's instruction, but it doesn't mean the user read the thread.
    if (!agent) this.repo.clearNotifications(actor.id, thread.id);
    if (this.channels.length === 0) return;
    const audience = this.repo.audience(thread.projectId);
    const members = audience.map(({ user }) => user);
    const mentioned = body ? mentionedIds(body, members) : new Set<string>();
    // In the thread: whoever started it, wrote in it, or was mentioned in it earlier.
    const involved = new Set([thread.author.id]);
    for (const comment of thread.comments) {
      involved.add(comment.author.id);
      if (comment.id !== commentId) for (const id of mentionedIds(comment.body, members)) involved.add(id);
    }
    const createdAt = this.now();
    this.repo.queueNotifications(
      audience
        .filter(({ user, level, channels }) => user.id !== actor.id && wants(level, mentioned.has(user.id), involved.has(user.id)) && this.channelsFor(user, channels).length > 0)
        .map(({ user }) => ({ userId: user.id, threadId: thread.id, commentId, event, mention: mentioned.has(user.id), actorId: actor.id, agent, createdAt })),
    );
  }

  /** Sends what's due; returns how many digests went out. Safe to call often. */
  async deliver(): Promise<number> {
    if (this.delivering) return 0;
    this.delivering = true;
    try {
      const now = this.now();
      this.repo.deleteNotificationsBefore(now - STALE_MS);
      const byUser = new Map<string, PendingNotification[]>();
      for (const row of this.repo.dueNotifications(now - this.quietMs, now - this.maxWaitMs)) {
        byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
      }
      let sent = 0;
      for (const [userId, rows] of byUser) {
        const ids = rows.map((row) => row.id);
        const user = this.repo.findActiveUser(userId);
        const channels = user ? this.channelsFor(user, this.repo.notificationSettings(userId).channels) : [];
        const digest = user && this.digest(user, rows);
        if (!digest || channels.length === 0) {
          this.repo.deleteNotifications(ids);
          continue;
        }
        const results = await Promise.allSettled(channels.map((channel) => channel.deliver(digest)));
        for (const result of results) if (result.status === 'rejected') console.error('Sending a notification failed:', result.reason);
        if (results.some((result) => result.status === 'fulfilled')) {
          this.repo.deleteNotifications(ids);
          sent++;
        } else {
          this.repo.failNotifications(ids, MAX_ATTEMPTS);
        }
      }
      return sent;
    } finally {
      this.delivering = false;
    }
  }

  start(): void {
    this.stop();
    if (this.channels.length === 0) return;
    const every = Math.min(15_000, Math.max(1_000, this.quietMs / 4));
    this.timer = setInterval(() => void this.deliver().catch((error) => console.error('Delivering notifications failed:', error)), every);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private digest(user: User, rows: PendingNotification[]): Digest | null {
    const threads: DigestThread[] = [];
    const byThread = new Map<string, PendingNotification[]>();
    for (const row of rows) byThread.set(row.threadId, [...(byThread.get(row.threadId) ?? []), row]);
    for (const [threadId, pending] of byThread) {
      const thread = this.repo.findThread(threadId);
      if (!thread) continue;
      const events = pending.flatMap((row): DigestEvent[] => {
        if (row.event !== 'comment') {
          return [{ kind: row.event, actor: this.repo.userName(row.actorId) ?? 'Someone', agent: row.agent, body: null, mention: false, at: row.createdAt }];
        }
        // A comment deleted before we got to it isn't news anymore.
        const comment = thread.comments.find((c) => c.id === row.commentId);
        if (!comment) return [];
        const kind = comment === thread.comments[0] ? 'thread' : 'comment';
        return [{ kind, actor: comment.author.name, agent: comment.agent ?? null, body: comment.body, mention: row.mention, at: comment.createdAt }];
      });
      if (events.length === 0) continue;
      const project = this.repo.findProject(thread.projectId);
      // The share hash takes the URL's hash, so a route hash is left out; the overlay goes on to the thread's own URL.
      const url = threadUrls({ ...thread, hash: undefined }, project?.origins ?? [])[0];
      threads.push({
        id: thread.id,
        project: project?.name ?? 'OpenParley',
        page: threadPath(thread),
        element: thread.anchor.text ? `"${truncate(thread.anchor.text, 60)}"` : `<${thread.anchor.tag}>`,
        status: thread.status,
        url: url ? `${url}#parley=t.${thread.id}` : null,
        events,
      });
    }
    return threads.length ? { recipient: { id: user.id, name: user.name, email: user.email }, threads, settingsUrl: this.settingsUrl } : null;
  }
}

/** Mentions always reach you unless you switched everything off. */
export function wants(level: NotifyLevel, mentioned: boolean, involved: boolean): boolean {
  if (level === 'off') return false;
  return mentioned || level === 'everything' || (level === 'participating' && involved);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
