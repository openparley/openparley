# Architecture

```
            any website                                     your server (optional)
┌──────────────────────────────────┐             ┌──────────────────────────────────┐
│ <script src=".../openparley.js"> │             │ apps/sync  (Bun, Hono, SQLite)   │
│                                  │  JSON API   │                                  │
│  overlay (Preact, shadow root)   │────────────▶│  /api/*     bearer token, CORS   │
│   ├─ LocalStore  (localStorage)  │             │  /connect   sign-in popup        │
│   └─ SyncStore   (fetch + poll)  │◀── token ───│  /admin     projects, members    │
│                                  │ postMessage │  /openparley.js  serves overlay  │
└──────────────────────────────────┘             └──────────────────────────────────┘
       ▲ share links (#parley=…)
```

| Package | Role |
|---------|------|
| `packages/protocol` | Types for anchors, threads and API payloads. Imported by both sides. |
| `packages/overlay` | Everything that runs on the host page. Builds a loader, `dist/openparley.js`, and the overlay it fetches, `dist/openparley-app-<hash>.js`. |
| `apps/sync` | Optional team server. One instance is one organization. |
| `ee/cloud` | OpenParley Cloud: many organizations in one process, each an unmodified Sync instance. |
| `apps/site` | Landing page with a live demo, and docs. Static files. |

## Overlay

**Loading.** The script tag points at `openparley.js`, a loader of under 1 KB gzipped (`loader.ts`). It reads the `data-*` attributes and asks `gate.ts` whether this visitor needs OpenParley. That check is synchronous and uses no network. Only if the answer is yes does it `import()` the overlay, `openparley-app-<hash>.js`, from next to itself. The app's file name contains a content hash, so it is cached forever; the loader is cached for 5 minutes, so a release takes effect within minutes.

| `data-launcher` | The overlay loads when… |
|-----------------|-------------------------|
| `always` (default) | always |
| `auto` | `#openparley` or a thread link was opened in this browser once (`openparley:v1:enabled`) |
| `members` | someone signed in to the team server in this browser (`openparley:v1:member:<server>`), or the URL contains `#openparley` or a thread link |

`#openparley=off` clears either flag.

In `members` mode, the flag is set when the server confirms a session (`GET /api/me`). It is cleared only by an explicit **Sign out**: an expired or revoked token still loads the overlay, with a **Sign in** button, so teammates aren't silently locked out. The gate is a matter of visibility and download size, not security. Someone who sets the flag by hand gets a Sign in button and nothing else, because all data still requires a server session.

**Mounting.** `mount()` (the app's export, also usable from npm) applies the same gate, then creates `<openparley-overlay>` with an open shadow root and appends it to `<html>`, not `<body>`, so it never shifts the page's own `nth-of-type` paths. Styles live inside the shadow root; page CSS can't reach in and ours can't leak out. The one exception is the font: `@font-face` doesn't work inside a shadow root, so `font.ts` adds a single rule to the page under the private family name `OpenParley Sans`, pointing at the content-hashed `openparley-font-*.woff2` files next to the app. If the page's CSP blocks fonts, the overlay falls back to the system font. The host is a full-viewport `position: fixed` layer with `pointer-events: none`; only pins, cards and the launcher take pointer events.

**State.** `ui/App.tsx` owns one view state:

```
closed ──open──▶ browse ──C / Comment──▶ pick ──click element──▶ compose ──post──▶ thread
   ▲               │  ▲                    │                        │                │
   └─────Esc───────┘  └────────Esc─────────┴────────────Esc─────────┴──────Esc───────┘
```

Data comes from a store (`store/local.ts` or `store/sync.ts`) behind the same interface. Components subscribe; they never touch storage or the network directly. Whether the overlay is open is remembered in `sessionStorage` across page loads.

**Anchors** (`anchor.ts`). Clicking an element records:

- a unique CSS selector (finder, with generated/utility class names filtered out)
- a structural `nth-of-type` path
- tag name and normalized text (first 120 characters)
- identifying attributes (`id`, `data-testid`, `aria-label`, `name`, `href`…)
- the click point as fractions of the element box

To find the element again, candidates from the selector, the path and the id/test-id attributes are scored on tag (required), text similarity and attribute agreement. Below the threshold, a unique exact-text match is tried. Otherwise the thread is reported as not found, never pinned to a guess.

**Positioning** (`tracker.ts`). Everything is `position: fixed`. The `Tracker` measures every tracked element in one `requestAnimationFrame` after scroll, resize, `ResizeObserver` or DOM mutations, plus a 300 ms safety poll for CSS animations. Results go straight into `style.transform`; nothing re-renders on scroll. Points clipped by a scrolling ancestor hide their pin. The element in focus (hovered while picking, or the open thread's element) gets a spotlight: one fixed box whose large `box-shadow` dims the rest of the page. It has `pointer-events: none`, so the page stays clickable. While picking, the native cursor is hidden and a pin drawn by the overlay follows the pointer (its tip is where the pin will land); image cursors render too inconsistently across browsers to rely on. It glides between elements but follows scrolling instantly. Cards are placed beside the element (right, left, below, above) and only fall back to the pin when the element is too large for any side. DOM mutations also trigger re-resolution of anchors, throttled to every 250 ms.

**Touch** (`ui/tap.ts`). Decided per event by `PointerEvent.pointerType`, never by user agent, so a touchscreen laptop with a mouse behaves like a desktop. A finger has no hover, so in pick mode the first tap highlights an element (spotlight and label) and a second tap on the same element picks it; a tap elsewhere moves the highlight. A tap is decided at `touchend`: the touch pointer must not have been cancelled (the browser cancels a pointer it scrolls with) or moved more than 10px. Deciding there matters because `touchend`'s `preventDefault()` is what cancels the tap's click; by the time a click would arrive the Picker has unmounted, so the page would get it. It also means iOS's unreliable clicks on non-interactive elements don't matter. While picking, the page hears no `touchstart`/`touchend`, the same as pointer and mouse events. Closing an open card by touching the page also waits for a tap, so scrolling keeps a draft. The pick hint follows the last pointer type (`(hover: none)` before any pointer event). `(hover: none)` hides key hints and shows hover-only controls; `(pointer: coarse)` gives pins and buttons an invisible 44px hit area and fields 16px text (iOS zooms into smaller fields).

**Bottom sheet.** At `max-width: 600px` (`SHEET_QUERY` in `Floating.tsx`, matched by a `@media` block in `styles.css`) every card, thread, composer and list, is a full-width sheet at the bottom of the screen instead. `Floating` decides it, so there is one placement path: for a sheet it doesn't place, it scrolls the page once per element so the element (or its pin, if the element is too tall) sits above the sheet, and App doesn't centre the element as it does on wider screens. The toolbar hides while a sheet is open, since every sheet has its own close button. While a field in the sheet has focus, `visualViewport` lifts the sheet above the on-screen keyboard (`--op-keyboard`).

**Navigation** (`page.ts`). Threads belong to a page key: the pathname, without a trailing slash or `index.html`. `pushState`/`replaceState` are wrapped once and never unwrapped, and `popstate`/`hashchange` are observed.

## Local mode and share links

`LocalStore` keeps `{ [threadId]: Thread }` under `openparley:v1:threads`. Every write is read-modify-write against the latest stored copy, and the `storage` event keeps tabs in sync. The display name and a random author id live under `openparley:v1:me`.

**Copy link** encodes the thread as `#parley=z1.<base64url(deflate-raw(JSON))>`. On open:

1. The payload is validated field by field (`share.ts`, `isThread`).
2. It's merged into local storage: comments are a union by id, and the newest status change wins (`merge.ts`).
3. The hash is removed from the URL.
4. The thread opens on its element.

The hash never reaches any server. Team-mode links are just `#parley=t.<threadId>`.

## Team mode

**Embedding.** `<script src="https://sync.example.com/openparley.js" data-project="KEY" data-launcher="members">`. The server URL defaults to the script's origin. The server serves the loader and the hashed app, cross-origin (`Access-Control-Allow-Origin: *`) so the dynamic `import()` works from any site. A host page with a Content-Security-Policy must allow the server's origin in `script-src` and `connect-src`.

**Sign-in handshake:**

1. The overlay opens `GET /connect?project=KEY&origin=<page origin>` in a popup.
2. The server rejects unknown projects and anything that isn't a canonical http(s) origin.
3. Without a server session cookie, the popup shows `/login` and then returns to `/connect`.
3a. If the origin isn't on the project's list (exact origins, or subdomain wildcards like `https://*.preview.example.com`: any depth below the base, same scheme and port, never the base itself; matching in `origins.ts`), a member gets "ask an admin", and an admin gets **Add this site?**: one `POST /connect/allow` (CSRF-checked, admins only, exact origin, never a wildcard) adds it and continues to step 4. The list is the security boundary: without it, any page could copy the public project key and collect teammates' tokens through the popup.
4. The server creates an API session and renders a page that calls `window.opener.postMessage({type:'openparley:connect', token}, origin)` with the exact allowed origin as `targetOrigin`, then closes.
5. The overlay accepts the message only if `event.origin` is the server's origin, and stores the token under `openparley:v1:token:<server>`.

Because the token is posted to an explicit `targetOrigin`, a page on another origin that opens the popup receives nothing. The popup is first-party, so third-party cookie blocking doesn't affect it.

**API** (all JSON, `Authorization: Bearer <token>`):

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/me` | Current user and role |
| POST | `/api/auth/logout` | Revokes the token |
| GET | `/api/members` | Active members (`id`, `name`, `handle`), for @mention suggestions and highlighting |
| GET | `/api/threads?project=&page=` | Threads with comments, oldest first |
| GET | `/api/threads/:id` | |
| POST | `/api/threads` | `{ project, page, anchor, body }` |
| PATCH | `/api/threads/:id` | `{ status }` |
| DELETE | `/api/threads/:id` | Author or admin |
| POST | `/api/threads/:id/comments` | `{ body }` |
| DELETE | `/api/threads/:id/comments/:commentId` | Author or admin; deleting the last comment deletes the thread |

CORS preflights succeed only for origins listed on some project. The overlay refreshes every 15 seconds while the tab is visible, and on focus.

**Environments and revisions.** Threads are namespaced by workspace → project → page (pathname) → environment. A new thread's `environment` is the site's `data-environment` label if set, otherwise the request's `Origin` (so each origin is its own environment by default); `revision` is the optional `data-revision` (e.g. a commit SHA) and is informational only. `GET /api/threads` returns the page's threads from every environment; the overlay's `SyncStore` splits them into `threads` (this environment, plus older threads without one) and `elsewhere`, which View all lists under "Other environments". Opening one places it on its element while it's open. Links-only mode has no environments: `localStorage` is per origin already.

**Agents (MCP)** (`mcp.ts`). `POST /mcp` is a Model Context Protocol server (Streamable HTTP, stateless: one JSON-RPC message or batch per request, JSON answers, no sessions or server-to-client stream; `GET` is 405). Hand-written rather than the SDK so Sync stays dependency-free; checked against the official TypeScript SDK client. It authenticates with an agent token (`opa_…`, sha-256 stored in `agent_tokens`), created by any signed-in user under Agents on `/admin` and shown once; requests from a browser origin other than `PUBLIC_URL` are refused. Agent tokens only work on `/mcp`, and API tokens don't. Tools: `list_threads` (filters: status, project, page, environment), `get_thread`, `reply_to_thread`, `resolve_thread`, `reopen_thread`. Threads report `urls` (the exact URL when the environment is an origin, else the page on every project origin), `environment` and `revision`. An agent acts as its user but can't create or delete threads or touch admin. Its comments store the agent's name (`comments.agent`, `Comment.agent` in protocol) and the overlay shows "agent · <user>". Agents aren't users, so they never count toward `MAX_MEMBERS`; removing a user deletes their agent tokens. The server's `instructions` tell the agent to treat thread text as a request, not as instructions that override its own.

**Agent sign-in (OAuth)** (`oauth.tsx`). Each Sync server is its own OAuth 2.1 authorization server for `/mcp`, as the MCP authorization spec describes, so Cloud gets it per workspace with no Cloud code. A 401 from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata=…`; `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728) points to this server, and `/.well-known/oauth-authorization-server` (RFC 8414) lists the endpoints. Clients register themselves at `/oauth/register` (RFC 7591, open, rate-limited per IP; redirect URIs must be https, loopback http or an app scheme like `cursor://`); unused registrations are swept after 7 days. `/oauth/authorize` is mounted inside the web routes (session, CSRF, CSP): it requires PKCE S256 and, if sent, `resource` = this server's `/mcp`, then shows a consent page naming the client (self-asserted) and where the browser goes next. Errors about the client or redirect URI stay on our page so it's never an open redirector. Approving returns an HTML page with a meta refresh, not a 302, because browsers apply the page's `form-action 'self'` to redirects after a form post. The single-use code (5 minutes) becomes an `agent_tokens` row with `client_id`: a 1-hour access token (`opa_…`) and a rotating 90-day refresh token (`opr_…`), both stored hashed. Signing in again with the same client replaces its row; revoking on `/admin` or at `/oauth/revoke` (RFC 7009) ends it. Loopback redirect URIs may change port (RFC 8252). Public clients (`none`) are the norm; `client_secret_basic`/`_post` are accepted. Pasted agent tokens never expire and keep working.

**Mentions and notifications** (`mentions.ts`, `notify.ts`, `notify-email.ts`). A mention is plain text, Slack-style: `@handle`, or `@Full Name` (what agents tend to write). Every user has a handle (`users.handle`: lowercase, `[a-z0-9._-]`, no trailing dot or dash so `@mia.` ends a sentence, unique among all accounts ever, so an old mention never points at someone new). It's generated from the name (`mia`, else `mia.designer`, else `mia2`), backfilled for older accounts when the database opens, and changed by its owner on `/admin`. The longest reading wins (`@sam.smith` vs `@Sam Smith` vs `@sam`); never inside words or email addresses. The server resolves mentions when it records an event, so the protocol has no mention field. The overlay gets members with handles from `GET /api/members` (fetched once): the composer suggests them after `@` or from its @ button (matching the handle or the start of any name word) and inserts `@handle`; comments highlight `@handle` of current members (still text nodes), mentions of you in yellow.

Events (a new thread, a comment, resolve/reopen; from the API or MCP) are turned into one `notifications` row per recipient straight away. Who: anyone mentioned, plus, by each user's level for that project, people in the thread (`participating`, the default: started it, wrote in it, or were mentioned in it earlier; an agent's comment counts for its user) or everyone (`everything`); `mentions` gets mentions only and `off` nothing. Never the actor themselves, also not for their own agent's actions. Acting on a thread yourself (commenting, resolving) drops what was still waiting for you about it, because you've seen it. Levels are a default per user plus optional per-project overrides (`notification_settings`, `notification_project_levels`).

Delivery batches: every few seconds `Notifier.deliver()` takes, per recipient, the threads whose newest waiting row is older than `NOTIFY_QUIET_SECONDS` (60) or whose oldest has waited 10 minutes (so a conversation that never pauses still arrives), and sends them as one digest. Rows reference comments, so a comment deleted before delivery isn't sent and a deleted thread takes its rows with it. Failed sends retry up to 5 times; anything older than a day is dropped. The queue lives in the database, so batches survive restarts, and Cloud doesn't close an idle workspace while it has rows waiting.

Delivery is channel-agnostic: a digest goes to every `Channel` the user has switched on (`notification_channels`; a channel without a switch uses its `defaultOn`). Email (`notify-email.ts`, plain text, link `…#parley=t.<id>` on the thread's origin, `List-Unsubscribe` + one-click POST per RFC 8058) is the only one so far; Slack or Teams would be another `Channel` passed to `createApp`. Without a mailer there are no channels and nothing is queued. `/unsubscribe/<token>` (a random per-user token that can only switch email off) is outside the CSRF check because mail clients post to it; opening it shows a button, since mail scanners prefetch links.

**Data.** SQLite with foreign keys on. Tables: `users` (removed users keep their name on old comments), `sessions` (sha-256 of the token, kind `web` or `api`, 30-day expiry), `projects` (id is the public key, plus allowed origins), `invites` (hashed single-use tokens, 7 days), `threads` (with `environment` and `revision`), `comments` (with `agent` for replies written by an agent), `agent_tokens` (pasted tokens, and OAuth sign-ins with `client_id`, expiry and refresh hash), `oauth_clients`, `oauth_codes`, `counters`, `notifications` (the delivery queue), `notification_settings`, `notification_project_levels`, `notification_channels`. Migrations are append-only SQL tracked with `PRAGMA user_version`.

**Admin.** Server-rendered pages:

- `/setup` takes a one-time token printed at first boot.
- `/admin` manages projects, origins, members and invites (admins), and each user's own agents. It lists every non-wildcard site as `<origin>/#openparley`, which switches the overlay on for that browser even with `data-launcher="members"`; accepting an invite lands on it with a welcome.
- Invites can carry an email address. With `RESEND_API_KEY`/`MAIL_FROM` (or Cloud's mailer, passed to every workspace) the invite is emailed, replies going to the inviter; otherwise, or if sending fails, the admin gets the link to send. `MAIL_LOG=1` (used by `bun run dev`) writes emails to the log instead.
- Every user sets their **Notifications** there (see below).
- `/invite/:token` creates an account.

Forms are protected by `SameSite=Lax` cookies plus an Origin check against `PUBLIC_URL`. Every page sends a CSP with `frame-ancestors 'none'`.

## Cloud

Cloud is not a second backend. It imports Sync's `openInstance()` and runs one instance per workspace inside a single process:

```
                    *.openparley.dev (wildcard DNS + TLS)
                                  │
                ┌─────────────────▼─────────────────┐
                │ ee/cloud (one Bun process)      │
cloud.<domain> ─▶ control plane   data/control.db   │  workspaces, status, limits
<slug>.<domain> ─▶ router ──▶ openInstance(data/tenants/<slug>.db)   ← Sync, unchanged
                └───────────────────────────────────┘
```

- **Isolation is structural.** The hostname picks the database file; Sync has no tenant column anywhere, so one workspace's queries cannot reach another's data. Sessions, tokens, cookies (host-only), CORS and setup links are all per workspace.
- **Instances open lazily** on the first request and close after `IDLE_MINUTES` (default 10) without traffic, or when more than `MAX_OPEN_WORKSPACES` are open (least recently used first). Idle workspaces cost only disk.
- **Every request re-reads its workspace row** in `control.db` (one indexed lookup), so suspending a workspace or changing its limits applies immediately, also when done from the CLI in another process.
- **Billing stays out of Sync.** Plans map to Sync's generic `limits` (`maxMembers`, `maxProjects`, `maxThreads`, also available to self-hosters as `MAX_MEMBERS` / `MAX_PROJECTS` / `MAX_THREADS`). `MAX_THREADS` counts threads ever created (a counter in Sync's database, so deleting doesn't free room) and never blocks replies or status changes. When a workspace has more active members than `MAX_MEMBERS` (e.g. after a downgrade), existing members keep their access but nobody can start new threads. `LIMITS_URL` (Cloud: the workspace's plan page) is linked next to the counters on the admin page. An ended subscription moves the workspace to the Free plan's limits; only an operator suspends a workspace (the router then answers 402, page visits go to its page on the control plane, and the data stays).
- **Onboarding reuses Sync's first-run flow.** Provisioning creates the database and a setup token; the owner gets `https://<slug>.<domain>/setup?token=…`.
- **Scaling:** one process uses one core. Grow by sharding workspaces across processes or machines (a slug → shard map in `control.db`, moving a workspace is copying one file), not by a process per customer. A dedicated process for one customer is still possible: it's just Sync's `main.ts`.

Measured with `bun ee/cloud/scripts/load.ts` on an M-series laptop: 500 provisioned workspaces add no measurable memory while idle; about 1.6 MB per open workspace with data (most of it SQLite's per-connection page cache); about 12,000 thread-list requests per second on one core, round-robin across 50 workspaces.

**Sign-up and billing** (`control-plane.tsx`, `billing.ts`, `polar.ts`, `plans.ts`). Polar is the merchant of record: we use its hosted checkout and customer portal and build no billing UI. Two plans: **Free** (one member plus their agents, unlimited threads, no Polar product) and **Team** ($19/month, no limits, 31-day trial set on the Polar product; `POLAR_PRODUCT_TEAM`, created with `ee/cloud/scripts/create-polar-product.ts`). The trial is offered once per workspace: an upgrade checkout for a workspace that had a subscription sends `allow_trial: false`.

0. **Free sign-up** stores a `signups` row (slug reserved 24 h) and emails a confirmation link instead of starting a checkout. Opening the link shows a button (mail scanners prefetch links); pressing it provisions the workspace with plan `free` and the sign-up email as billing contact, creates (or, for an email Polar already knows, reuses) the Polar customer with `metadata.workspace = <slug>` as best effort with a 5 s timeout, then redirects to the owner setup page. Free workspaces therefore show up in Polar's customer list, and a later upgrade checks out as that customer. The free workspace's page on the control plane (`/workspaces/<slug>`, linked from its admin page) shows threads used and emails an upgrade link to the billing contact; that is the upgrade flow of step 5. The webhook then switches the plan to Team, which lifts the thread limit.
1. `cloud.<domain>/signup` (Team) takes a workspace name, address (slug), email and plan. It stores a `signups` row that reserves the slug while the checkout is open (other browsers get "taken"), sets a browser cookie, creates a Polar checkout with `metadata.signup`, and redirects to it.
2. Polar returns the customer to `/signup/done?signup=…`, which refreshes itself until the webhook has provisioned the workspace, then shows the setup link. Only the browser holding the sign-up cookie sees the link; anyone else with the URL gets "Payment received". The link is also emailed.
3. `POST /webhooks/polar` checks the Standard Webhooks signature (also the pre-Sep 2026 key format) and the timestamp. In one transaction it records the delivery id in `billing_events` (a redelivery is a no-op), and stores the subscription in `subscriptions` only if it is at least as new (`modified_at`) as what we have, so late events never undo newer ones.
4. Every `subscription.*` event carries the whole subscription, so its `status` decides, not the event type. `active`, `trialing` and `past_due` mean paid (Polar retries failed payments for up to 21 days, then revokes). `canceled`, `unpaid`, `paused` and `incomplete_expired` mean ended. "Cancel at period end" stays paid until the period is over. The first paid state provisions the workspace from its sign-up, with limits from the plan. A product change updates the limits. **An ended subscription drops the workspace to Free**: nothing is deleted; if it has more members than Free allows, nobody can start new threads (Sync's generic over-the-member-limit rule) until it upgrades or members are removed, and the billing contact gets an email with an upgrade link (30 days). If the same subscription becomes paid again (resumed in Polar's portal), the workspace is back on Team.
5. **Upgrading a free workspace** (new or downgraded). Its page `cloud.<domain>/workspaces/<slug>` (linked from the admin page via `LIMITS_URL`) emails an upgrade link (24 h, masked address shown, max 3 per hour) to the billing contact; the billing email is the identity, as in Polar's portal. Opening the link changes nothing (mail scanners prefetch links); its form starts a Polar checkout (for the existing Polar customer if there is one) with `metadata.renew = <slug>`, and the webhook moves the workspace onto the new subscription and the Team plan. Events about an old subscription then no longer match the workspace. A second paid checkout for an already-paid workspace is logged for a refund, never applied. A Polar-`paused` or `unpaid` (not ended) subscription goes to a signed-in customer-portal session instead, so it is resumed rather than paid twice.
6. **Paused workspaces** are an operator's decision (`cli suspend`), never billing's. Page visits (`Sec-Fetch-Mode: navigate`) redirect to the workspace's page on the control plane, which points to support; the overlay's script and API calls get a plain 402. Paying doesn't lift a pause.
7. "Manage billing" (`/billing`) redirects to Polar's customer portal. Polar signs the customer in with a code sent to their billing email, so the control plane has no accounts of its own.

`control.db` uses append-only migrations tracked with `PRAGMA user_version`, like Sync. Sign-up is closed until the `POLAR_*` variables are set. `bun run dev:cloud` runs against a fake Polar (`ee/cloud/dev/fake-polar.ts`, also used by e2e) and writes emails to the log.

Not built yet: backups (plan: continuous per-file replication such as Litestream to object storage).

**Deployment.** Each deployable has a Dockerfile, built from the repository root: `ee/cloud/Dockerfile`, `apps/site/Dockerfile` (nginx serving the static build) and `apps/sync/Dockerfile` (self-hosting; never contains `ee/`). CI promotes `master` to the `deploy` branch only when everything passes, and Coolify deploys `deploy`.

| Variable | Default | |
|----------|---------|-|
| `CLOUD_DOMAIN` | `localhost` | Workspaces at `<slug>.<domain>`, control plane at `cloud.<domain>` |
| `DATA_DIR` | `ee/cloud/data` | `control.db` and `tenants/*.db` |
| `IDLE_MINUTES` | `10` | Close a workspace after this long without requests |
| `MAX_OPEN_WORKSPACES` | `500` | |
| `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_TEAM` | | All three open sign-up (Free and Team); webhook endpoint is `https://cloud.<domain>/webhooks/polar` |
| `POLAR_ORG` | | Polar organization slug, for the customer portal link (or set `POLAR_PORTAL_URL`) |
| `POLAR_SERVER` | `production` | `sandbox` for Polar's sandbox |
| `RESEND_API_KEY`, `MAIL_FROM` | | Without them, emails (confirmation, setup, renewal and upgrade links) go to the log |
| `SUPPORT_EMAIL` | | Reply-to of every email, and shown on paused workspaces |
| `NOTIFY_QUIET_SECONDS` | `60` | Passed to every workspace: how long a thread is quiet before its notifications are emailed |

## Security notes

- Comment text is rendered as text, never as HTML, and links aren't made clickable. A crafted share link can display a thread on your site, as with any link-based tool; use `data-launcher="members"` (team) or `"auto"` (links only) on public production sites.
- The API token sits in the host page's `localStorage`, so an XSS on that site can read it. The token only grants OpenParley access and can be revoked by signing out or removing the user.
- Failed logins are rate limited per IP and email, failed invite redemptions per IP (in memory, single process). Successful attempts never count, so a whole office behind one IP can sign up. Set `TRUST_PROXY=1` behind a reverse proxy.
