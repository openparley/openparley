import type { Anchor, Author, Thread, ThreadStatus } from '@openparley/protocol';
import type { PageRef } from '../page';

export type StoreStatus = 'loading' | 'ready' | 'signed-out' | 'error';

export interface StoreState {
  status: StoreStatus;
  /** Threads on every page of this environment, oldest first. */
  threads: Thread[];
  /** Team mode: threads on the current base path made in other environments (e.g. production while you're on staging). */
  elsewhere: Thread[];
  /** Local mode: always set (name may still be empty). Sync mode: null until signed in. */
  user: (Author & { admin?: boolean }) | null;
  error: string | null;
}

export abstract class BaseStore {
  protected state: StoreState = { status: 'loading', threads: [], elsewhere: [], user: null, error: null };
  private listeners = new Set<() => void>();

  getState(): StoreState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected setState(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  canDelete(author: Author): boolean {
    const user = this.state.user;
    return !!user && (user.id === author.id || !!user.admin);
  }

  /** The current base path (`pageKey`); only decides which other environments' threads are fetched. */
  abstract setPage(page: string): void;
  abstract createThread(where: PageRef, anchor: Anchor, body: string): Promise<Thread>;
  abstract addComment(threadId: string, body: string): Promise<void>;
  abstract setStatus(threadId: string, status: ThreadStatus): Promise<void>;
  abstract deleteThread(threadId: string): Promise<void>;
  abstract deleteComment(threadId: string, commentId: string): Promise<void>;
  abstract destroy(): void;
}
