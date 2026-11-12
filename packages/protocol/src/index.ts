// Wire format shared by the overlay, share links and the sync server.
// Changing a shape here is a breaking change for stored data and links: bump the version.

export const ANCHOR_VERSION = 1;

/** Everything needed to find an element again on a later visit. */
export interface Anchor {
  v: typeof ANCHOR_VERSION;
  /** Unique CSS selector at creation time (may be empty if generation failed). */
  selector: string;
  /** Structural fallback: `tag:nth-of-type(n)` chain from <body>. */
  path: string;
  /** Lower-case tag name. */
  tag: string;
  /** Whitespace-normalised text content, truncated. Used to verify and disambiguate. */
  text: string;
  /** Stable identifying attributes (id, data-testid, aria-label, name, role, href...). */
  attrs: Record<string, string>;
  /** Where inside the element the pin sits, as fractions of its width/height (0..1). */
  point: [number, number];
}

export type ThreadStatus = 'open' | 'resolved';

export interface Author {
  id: string;
  name: string;
}

export interface Comment {
  id: string;
  author: Author;
  /** Set when an agent (e.g. a coding assistant over MCP) wrote it on the author's behalf: the agent's name. */
  agent?: string;
  body: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface Thread {
  id: string;
  /** Normalised pathname of the page the thread belongs to. Threads are grouped by it. */
  page: string;
  /**
   * The page's query string when the thread was made, without tracking parameters and sorted by key
   * (`?id=2&tab=specs`). Absent when there was none, and on threads from before it was recorded.
   */
  search?: string;
  /** A route hash (`#/settings`, `#!/x`) when the thread was made. Plain `#section` hashes aren't kept. */
  hash?: string;
  /**
   * Where it was made: the page's origin (`https://staging.example.com`), or the site's
   * `data-environment` label. Threads show in their own environment by default. Absent on threads
   * from before environments existed and on links-only threads; those show everywhere.
   */
  environment?: string;
  /** The site's `data-revision` when the thread was made (e.g. a commit SHA). Informational only. */
  revision?: string;
  anchor: Anchor;
  status: ThreadStatus;
  /** When `status` last changed; used to merge copies of the same thread. */
  statusAt: number;
  createdAt: number;
  author: Author;
  comments: Comment[];
}

export const LIMITS = {
  commentBody: 4000,
  authorName: 80,
  anchorText: 120,
  anchorSelector: 1000,
  anchorPath: 2000,
  anchorAttrValue: 200,
  agentName: 40,
  environment: 200,
  revision: 100,
  search: 2000,
  hash: 1000,
} as const;

// --- Sync HTTP API -------------------------------------------------------

export interface MeResponse {
  user: Author & { email: string; role: Role };
}

export type Role = 'owner' | 'admin' | 'member';

/** A teammate you can mention: `@handle` in comment text (Slack-style: lowercase, no spaces, unique). */
export interface Member extends Author {
  handle: string;
}

/** Active members of the workspace, for @mention suggestions and highlighting. */
export interface MembersResponse {
  members: Member[];
}

export interface ThreadsResponse {
  threads: Thread[];
}

export interface ThreadResponse {
  thread: Thread;
}

export interface CreateThreadRequest {
  project: string;
  page: string;
  search?: string;
  hash?: string;
  anchor: Anchor;
  body: string;
  /** The site's `data-environment`; without it the server uses the request's Origin. */
  environment?: string;
  revision?: string;
}

export interface AddCommentRequest {
  body: string;
}

export interface UpdateThreadRequest {
  status: ThreadStatus;
}

export interface ErrorResponse {
  error: string;
}

/** Message the sync server's connect popup posts back to the embedding page. */
export interface ConnectMessage {
  type: 'openparley:connect';
  token: string;
}
