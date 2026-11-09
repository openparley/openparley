import { LIMITS, type Anchor, type Author, type Thread, type ThreadStatus } from '@openparley/protocol';
import { randomId } from '../id';
import { mergeThread } from '../merge';
import { isThread } from '../share';
import { BaseStore } from './base';

const THREADS_KEY = 'openparley:v1:threads';
const ME_KEY = 'openparley:v1:me';

type ThreadMap = Record<string, Thread>;

/** Keeps threads in this browser's localStorage. No server, no accounts. */
export class LocalStore extends BaseStore {
  readonly kind = 'local';
  private page: string;
  private memory: ThreadMap = {};
  private storage = openStorage();

  constructor(page: string) {
    super();
    this.page = page;
    window.addEventListener('storage', this.onStorage);
    this.setState({
      status: 'ready',
      user: this.readMe(),
      threads: this.threadsFor(page),
      error: this.storage ? null : 'Browser storage is unavailable, so threads will be lost when you leave this page.',
    });
  }

  setPage(page: string): void {
    this.page = page;
    this.refresh();
  }

  setName(name: string): void {
    const user = { id: this.state.user?.id ?? randomId(), name: name.trim().slice(0, LIMITS.authorName) };
    this.write(ME_KEY, user);
    this.setState({ user });
  }

  /** Merges threads received through a share link. Returns them as stored after merging. */
  importThreads(incoming: Thread[]): Thread[] {
    const merged: Thread[] = [];
    this.update((all) => {
      for (const thread of incoming) {
        const existing = all[thread.id];
        all[thread.id] = existing ? mergeThread(existing, thread) : thread;
        merged.push(all[thread.id]!);
      }
    });
    return merged;
  }

  async createThread(page: string, anchor: Anchor, body: string): Promise<Thread> {
    const author = this.author();
    const now = Date.now();
    const thread: Thread = {
      id: randomId(),
      page,
      anchor,
      status: 'open',
      statusAt: now,
      createdAt: now,
      author,
      comments: [{ id: randomId(), author, body, createdAt: now }],
    };
    this.update((all) => {
      all[thread.id] = thread;
    });
    return thread;
  }

  async addComment(threadId: string, body: string): Promise<void> {
    const author = this.author();
    this.update((all) => {
      const thread = all[threadId];
      if (!thread) throw new Error('This thread no longer exists.');
      all[threadId] = { ...thread, comments: [...thread.comments, { id: randomId(), author, body, createdAt: Date.now() }] };
    });
  }

  async setStatus(threadId: string, status: ThreadStatus): Promise<void> {
    this.update((all) => {
      const thread = all[threadId];
      if (thread) all[threadId] = { ...thread, status, statusAt: Date.now() };
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    this.update((all) => {
      delete all[threadId];
    });
  }

  async deleteComment(threadId: string, commentId: string): Promise<void> {
    this.update((all) => {
      const thread = all[threadId];
      if (!thread) return;
      const comments = thread.comments.filter((c) => c.id !== commentId);
      if (comments.length === 0) delete all[threadId];
      else all[threadId] = { ...thread, comments };
    });
  }

  override canDelete(): boolean {
    return true;
  }

  destroy(): void {
    window.removeEventListener('storage', this.onStorage);
  }

  private onStorage = (event: StorageEvent) => {
    if (event.key === THREADS_KEY || event.key === ME_KEY || event.key === null) {
      this.setState({ user: this.readMe() });
      this.refresh();
    }
  };

  private refresh(): void {
    this.setState({ threads: this.threadsFor(this.page) });
  }

  private author(): Author {
    const user = this.state.user;
    if (!user?.name) throw new Error('Add your name before posting.');
    return { id: user.id, name: user.name };
  }

  /** Read-modify-write against the latest stored copy so other tabs' changes aren't overwritten. */
  private update(mutate: (all: ThreadMap) => void): void {
    const all = this.readAll();
    mutate(all);
    this.write(THREADS_KEY, all);
    this.memory = all;
    this.refresh();
  }

  private threadsFor(page: string): Thread[] {
    return Object.values(this.readAll())
      .filter((t) => t.page === page)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private readAll(): ThreadMap {
    if (!this.storage) return { ...this.memory };
    const raw = this.read(THREADS_KEY);
    const all: ThreadMap = {};
    if (raw && typeof raw === 'object') {
      for (const value of Object.values(raw)) if (isThread(value)) all[value.id] = value;
    }
    return all;
  }

  private readMe(): Author {
    const me = this.read(ME_KEY) as Partial<Author> | null;
    if (me && typeof me.id === 'string' && typeof me.name === 'string') return { id: me.id, name: me.name };
    const fresh = { id: randomId(), name: '' };
    try {
      this.write(ME_KEY, fresh);
    } catch {
      // Without storage the identity simply lasts for this page view.
    }
    return fresh;
  }

  private read(key: string): unknown {
    try {
      const raw = this.storage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      throw new Error('Browser storage is full. Delete some resolved threads and try again.');
    }
  }
}

function openStorage(): Storage | null {
  try {
    const storage = window.localStorage;
    storage.getItem(THREADS_KEY);
    return storage;
  } catch {
    return null;
  }
}
