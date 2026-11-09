import type {
  Anchor,
  ConnectMessage,
  Member,
  MembersResponse,
  MeResponse,
  Thread,
  ThreadResponse,
  ThreadsResponse,
  ThreadStatus,
} from '@openparley/protocol';
import { memberKey, normalizeServer, setFlag } from '../gate';
import { BaseStore, type StoreState } from './base';

const POLL_MS = 15_000;

export interface SyncOptions {
  server: string;
  project: string;
  page: string;
  /** Groups origins that share threads; defaults to this page's origin. */
  environment?: string;
  revision?: string;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Keeps threads on a sync server, shared with everyone on the team. */
export class SyncStore extends BaseStore {
  readonly kind = 'sync';
  private readonly server: string;
  private readonly project: string;
  private readonly tokenKey: string;
  private page: string;
  private readonly environment: string;
  private readonly customEnvironment: string | undefined;
  private readonly revision: string | undefined;
  /** Every thread on the page, from all environments. */
  private all: Thread[] = [];
  private loadSeq = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private stopConnect: (() => void) | undefined;
  private memoryToken: string | null = null;
  private people: Promise<Member[]> | undefined;

  constructor(options: SyncOptions) {
    super();
    this.server = normalizeServer(options.server);
    this.project = options.project;
    this.page = options.page;
    this.customEnvironment = options.environment;
    this.environment = options.environment ?? location.origin;
    this.revision = options.revision;
    this.tokenKey = `openparley:v1:token:${this.server}`;
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('focus', this.onVisible);
    this.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && this.state.status === 'ready') void this.load();
    }, POLL_MS);
    void this.start();
  }

  setPage(page: string): void {
    if (page === this.page) return;
    this.page = page;
    this.setState(this.split([]));
    if (this.state.status === 'ready') void this.load();
  }

  /** Opens the server's sign-in window; resolves once a token has been received. */
  signIn(): Promise<void> {
    this.stopConnect?.();
    const url = `${this.server}/connect?project=${encodeURIComponent(this.project)}&origin=${encodeURIComponent(location.origin)}`;
    const popup = window.open(url, 'openparley-connect', 'width=440,height=620');
    if (!popup) return Promise.reject(new Error('Your browser blocked the sign-in window. Allow pop-ups for this site and try again.'));
    const serverOrigin = new URL(this.server).origin;
    return new Promise((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const data = event.data as Partial<ConnectMessage> | null;
        if (event.origin !== serverOrigin || data?.type !== 'openparley:connect' || typeof data.token !== 'string') return;
        cleanup();
        this.setToken(data.token);
        void this.start().then(resolve);
      };
      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        this.stopConnect = undefined;
      };
      this.stopConnect = cleanup;
      window.addEventListener('message', onMessage);
    });
  }

  async signOut(): Promise<void> {
    try {
      await this.request('POST', '/api/auth/logout');
    } catch {
      // The token is discarded locally either way.
    }
    this.setToken(null);
    // Only an explicit sign-out switches off `launcher: members`; an expired token must keep
    // showing teammates the Sign in button instead of silently hiding OpenParley.
    setFlag(memberKey(this.server), false);
    this.setState({ status: 'signed-out', user: null, ...this.split([]) });
  }

  /** Everyone you can @mention (yourself too, as in Slack); fetched once. */
  members = (): Promise<Member[]> =>
    (this.people ??= this.request<MembersResponse>('GET', '/api/members').then(
      ({ members }) => members,
      (error) => {
        this.people = undefined;
        throw error;
      },
    ));

  async fetchThread(threadId: string): Promise<Thread | null> {
    try {
      return (await this.request<ThreadResponse>('GET', `/api/threads/${encodeURIComponent(threadId)}`)).thread;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createThread(page: string, anchor: Anchor, body: string): Promise<Thread> {
    // Without a custom environment the server records the request's Origin, which the browser sets.
    const { thread } = await this.request<ThreadResponse>('POST', '/api/threads', {
      project: this.project,
      page,
      anchor,
      body,
      environment: this.customEnvironment,
      revision: this.revision,
    });
    this.upsert(thread);
    return thread;
  }

  async addComment(threadId: string, body: string): Promise<void> {
    this.upsert((await this.request<ThreadResponse>('POST', `/api/threads/${threadId}/comments`, { body })).thread);
  }

  async setStatus(threadId: string, status: ThreadStatus): Promise<void> {
    this.upsert((await this.request<ThreadResponse>('PATCH', `/api/threads/${threadId}`, { status })).thread);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.request('DELETE', `/api/threads/${threadId}`);
    this.setState(this.split(this.all.filter((t) => t.id !== threadId)));
  }

  async deleteComment(threadId: string, commentId: string): Promise<void> {
    await this.request('DELETE', `/api/threads/${threadId}/comments/${commentId}`);
    const thread = this.all.find((t) => t.id === threadId);
    if (!thread) return;
    const comments = thread.comments.filter((c) => c.id !== commentId);
    if (comments.length === 0) this.setState(this.split(this.all.filter((t) => t.id !== threadId)));
    else this.upsert({ ...thread, comments });
  }

  destroy(): void {
    clearInterval(this.pollTimer);
    this.stopConnect?.();
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('focus', this.onVisible);
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible' && this.state.status === 'ready') void this.load();
  };

  private async start(): Promise<void> {
    if (!this.getToken()) {
      this.setState({ status: 'signed-out', user: null });
      return;
    }
    try {
      const { user } = await this.request<MeResponse>('GET', '/api/me');
      setFlag(memberKey(this.server), true);
      this.setState({ user: { id: user.id, name: user.name, admin: user.role !== 'member' }, error: null });
      await this.load();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        this.setState({ status: 'error', error: messageOf(error) });
      }
    }
  }

  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const page = this.page;
    try {
      const query = `project=${encodeURIComponent(this.project)}&page=${encodeURIComponent(page)}`;
      const { threads } = await this.request<ThreadsResponse>('GET', `/api/threads?${query}`);
      if (seq === this.loadSeq) this.setState({ status: 'ready', error: null, ...this.split(threads) });
    } catch (error) {
      if (seq !== this.loadSeq || (error instanceof ApiError && error.status === 401)) return;
      // Keep showing the last known threads; a failed background refresh shouldn't wipe the page.
      this.setState({ status: this.state.status === 'loading' ? 'error' : this.state.status, error: messageOf(error) });
    }
  }

  private upsert(thread: Thread): void {
    if (thread.page !== this.page) return;
    const others = this.all.filter((t) => t.id !== thread.id);
    this.setState(this.split([...others, thread].sort((a, b) => a.createdAt - b.createdAt)));
  }

  /** Threads from before environments existed have none and show everywhere. */
  private split(all: Thread[]): Pick<StoreState, 'threads' | 'elsewhere'> {
    this.all = all;
    const here = (t: Thread) => !t.environment || t.environment === this.environment;
    return { threads: all.filter(here), elsewhere: all.filter((t) => !here(t)) };
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.getToken();
    let response: Response;
    try {
      response = await fetch(`${this.server}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(`Can't reach the OpenParley server at ${this.server}.`, 0);
    }
    if (response.status === 401) {
      this.setToken(null);
      this.setState({ status: 'signed-out', user: null, ...this.split([]) });
      throw new ApiError('Your session has expired. Sign in again.', 401);
    }
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) throw new ApiError(data?.error ?? `Request failed (${response.status}).`, response.status);
    return data as T;
  }

  private getToken(): string | null {
    try {
      return localStorage.getItem(this.tokenKey) ?? this.memoryToken;
    } catch {
      return this.memoryToken;
    }
  }

  private setToken(token: string | null): void {
    this.memoryToken = token;
    try {
      if (token) localStorage.setItem(this.tokenKey, token);
      else localStorage.removeItem(this.tokenKey);
    } catch {
      // Storage blocked: the session lasts until reload.
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
