# Review of the original codebase, and why this is a rebuild

Reviewed on 2026-11-06: `master` at `f1ac5f8` plus its uncommitted working tree (the `core → overlay`, `web → console` restructure, about 7,000 lines of TypeScript). Paths below refer to that tree.

## Verdict

The product thinking is good: VISION.md is clear, the free/paid split makes sense, and "collaborate on the site, not about it" is a sharp wedge. The implementation could not ship:

- The embed path, which is the whole product, didn't work end to end.
- Team mode was insecure by design.
- Nothing was tested.
- The docs described three different products.

Most problems were structural (two loaders, three share formats, React-sized bundle, per-user secret keys in page HTML), so fixing them in place would have touched nearly every file. A rebuild was cheaper and produces something we can reason about.

## End goals that were kept

1. One script tag on any site, any stack.
2. Click an element, start a threaded discussion pinned to it; reply, resolve, reopen.
3. Free use without any backend: the link carries the conversation.
4. A self-hostable server so a team sees all parleys, with accounts and roles.
5. Open source core; Cloud (hosted server + billing) later.

## Findings

### Blocking

| # | Finding | Where |
|---|---------|-------|
| 1 | The snippet loads `openparley-core.js`, but the build emits `openparley-overlay.iife.js`, so the UI never loads. The overlay's CSS is emitted as a separate file that nothing loads either. | `packages/overlay/src/snippet/index.ts:57`, `vite.config.ts:16,35` |
| 2 | The snippet shows no button. It only activates on `?parley=` or `data-auto-activate`, so a site that embeds it gives users no way in. | `snippet/index.ts:62-78` |
| 3 | Share formats disagree: the snippet reads `?parley=` (query), the overlay writes `#layer=` (hash), and a third legacy `Parley` shape is converted back and forth. A link made by the UI isn't picked up by the snippet. | `snippet/index.ts:74`, `anchor/encoder.ts:130`, `anchor/types.ts:96-140` |
| 4 | Team mode requires a user's full API key in the page's HTML (`data-api-key`). Anyone can view source and act as that user, including deleting teams. Project `allowedOrigins` were stored but never checked. | `sync/client.ts:25`, `apps/sync/src/server.ts` |
| 5 | The console doesn't compile (stray `])));`), so `/docs` is broken. | `apps/console/src/routes/docs.tsx:329` |
| 6 | No tests. `playwright.config.ts` points at a spec file that doesn't exist. | |
| 7 | Bundle: 815 KB raw / 247 KB gzipped, against "less than 5 KB" in README, VISION and CONTRIBUTING. | `dist/openparley-overlay.iife.js` |

### Correctness

- **Wrong-element pins.** The last-resort strategy calls `elementFromPoint` at the stored viewport percentage and reports 20% "confidence", so a parley silently lands on whatever is there now (`anchor/resolver.ts:158-162`).
- **Positioning.** Each indicator adds two capture-phase scroll listeners and calls `setState` per frame (`hooks/useElementPosition.ts`, `hooks/usePagePosition.ts`). The "no recalculation on scroll" note in CLAUDE.md was not true. Document-absolute coordinates also break for `position: fixed`/`sticky` elements and inner scroll containers.
- Every render re-resolves every anchor (`components/ParleyRoot.tsx:193`).
- `useRouteChange` patches `history.pushState` and restores the original on cleanup, which undoes patches other libraries applied after it (`hooks/useRouteChange.ts:59`).
- **Shortcuts.** `P` toggles mode while every doc says `C`, and `Escape` is `preventDefault`ed for the whole host page (`hooks/useKeyboardShortcuts.ts:37-44`).
- IDs are `thread-${Date.now()}`; imports dedupe by id, so two threads created in the same millisecond on different machines collide (`hooks/useThreads.ts:60`).
- Every local comment is authored by `"You"`, which makes shared conversations unreadable (`hooks/useThreads.ts:65,99`).
- A storage version mismatch silently returns no threads, dropping the user's data (`anchor/types.ts:177`).
- Sync failures silently fall back to localStorage, so users believe they're syncing when they aren't (`sync/context.tsx:69`).
- **Sync server:**
  - SQLite foreign keys are never enabled, so every `ON DELETE CASCADE` is decorative (`apps/sync/src/db/index.ts:16`).
  - The API-key prefix lookup is unindexed.
  - Subscription status is stored but never enforced.
  - The overlay talks to it with an Elysia client (the docs say Hono) and `as any` on every response, hiding the fact that the thread and comment shapes differ between client and server.

### Process and "slop"

- Four documents describe three incompatible UX models:
  - BEHAVIOR_SPEC: `Alt+A`, anchor/display states.
  - HAPPY_BEHAVIOR_SPEC: viewing/adding, `#layer=`.
  - CLAUDE.md: four states, and "no modifier keys", which contradicts `Alt+A`.
  - The code implements a fourth variant.
- Naming drift: Anker, anchor, parley, layer, thread and annotation are all in active use, alongside references to a `detector` package that no longer exists.
- Marketing claims nothing backs: 99.9% SLA, daily backups, GDPR compliance, "zero dependencies", an annual plan. The console README is the untouched TanStack scaffold.
- Dead code: `SimpleCommentPopover`, `ConfidenceBadge`, the unused `confidence` prop, `middleware/cors.ts`, demo threads. Comments throughout narrate what the code does.

## How the rebuild addresses them

| Finding | Now |
|---------|-----|
| Broken loader, missing CSS, no button | A 0.8 KB loader decides whether a visitor needs OpenParley and only then fetches the 21 KB overlay, CSS included in a shadow root. `data-launcher="members"` limits it to signed-in teammates on production sites. |
| Three share formats | One: `#parley=z1.<deflate+base64url JSON>` carries whole threads, `#parley=t.<id>` refers to a server thread. Versioned, validated field by field, consumed and removed from the URL on open. |
| Secret keys in HTML | The script tag holds only a public project key. Users sign in in a popup on the server, which posts a session token back only to origins on the project's allowlist. CORS uses the same list. |
| Wrong-element pins | Candidates come from selector, structure, test ids and text, scored together. Below the threshold the parley is listed as "element not found" instead of guessed. |
| Positioning | Overlay is `position: fixed`. One `Tracker` measures all pins in a single animation frame and writes transforms directly. Handles fixed/sticky elements and clipping scroll containers. |
| History patching | Patched once, never restored. |
| Shortcuts | `C` and `Esc` only, only while the overlay is open, never in fields, never with modifiers. |
| IDs, "You" | Random 96-bit ids. Local mode asks for a display name once. |
| Silent data loss | Corrupt entries are dropped individually; other tabs' writes are merged, not overwritten. Sync errors are shown to the user, never hidden behind a local fallback. |
| Sync server | `bun:sqlite` with `foreign_keys = ON`, append-only SQL migrations, zod at the edge, hashed tokens, argon2id passwords, login rate limiting, CSRF checks, CSP on every page. |
| Client/server drift | `packages/protocol` holds the shapes, and a server test runs API responses through the overlay's own validator. |
| No tests | 34 overlay unit tests, 23 server tests, 12 Playwright tests covering both modes end to end. |
| Doc drift | One README, one ARCHITECTURE, this review. Old specs removed. |

## Decisions that differ from the old docs

These are deliberate; push back on any of them.

1. **Admin lives on the server, not in the overlay.** ARCHITECTURE.md put team management in the overlay. Managing members from a floating widget on a marketing site is awkward. Admin pages are also the only UI a self-hoster has before any site embeds the script, and server-rendered forms need no API surface for roles and invites. The overlay stays focused on parleys.
2. **One server = one organization.** The old schema had teams, memberships and projects, while the docs said one instance per org. The rebuild follows the docs: users, projects, threads, comments. Cloud can run one instance per customer.
3. **Pins sit where you clicked**, not in the element's top-right corner. On large elements (a hero, a form) the click point carries meaning, and pins on shared corners stop stacking.
4. **5 KB for everyone isn't realistic; ~1 KB for people who don't use it is.** The full overlay (anchoring, compression, threaded UI, server client) is 21 KB gzipped; the old one was 247 KB. It sits behind a 0.8 KB loader, so with `data-launcher="members"` or `"auto"` most visitors pay under 1 KB.
5. **No console app, and Cloud is not a second backend.** `ee/cloud` runs an unmodified Sync instance per workspace (its own SQLite file) behind a hostname router, plus a small control plane. Sign-up and Polar billing come next, in that control plane; the old console's job folds into it.
6. **Polling (15 s, plus on tab focus) instead of realtime.** That's enough for review workflows; Server-Sent Events can come later without changing the API.
7. **Replies are allowed on resolved parleys.** Locking the composer frustrated quick "confirmed, looks good" replies. Status changes stay explicit.
8. **"Thread", not "parley" (Nov 2026).** VISION.md uses "open a parley" as the core verb; the UI, docs and code now say thread, a word nobody has to learn. OpenParley stays the product name, and share links keep the `#parley=` fragment so links already shared keep working.
9. **Audience: developers with coding agents, and the product team around them; not agencies (Nov 2026).** VISION.md sells to agencies. Two audiences now, in this order: developers who build with a coding agent adopt OpenParley on their own (Free), because a thread on an element is the context their agent needs; then the people who review the same product with them (PM, design/UX, QA, stakeholders) join, because pointing beats describing for them too. Their feedback lands where the developer's agent can act on it. That team is what pays for Team. Agent access is a collaboration feature, so it lives in the open core and works on every plan.
10. **Cloud workspaces live on their own subdomain, `<slug>.openparley.dev`, not under a path or one shared host (Nov 2026).** Sync owns the root of its origin (`/api`, `/mcp`, `/oauth/*`, `/.well-known/*`, cookies on `/`, absolute redirects from `PUBLIC_URL`). A subdomain lets Cloud run it unmodified, and a self-hosted server and a Cloud workspace look the same to the overlay, docs and agents. The origin is the browser's security boundary: cookies, storage, CORS, CSP, the sign-in popup's `postMessage` check and CSRF Origin checks keep workspaces apart without code of ours (paths share all of these). Each workspace is also its own OAuth issuer for MCP at the root `/.well-known/` URLs, which is what MCP clients handle best. `cloud.openparley.dev` stays the control plane (sign-up, billing, Polar webhook), apart from workspace sessions. The cost is no single MCP URL for directories that list one; a universal `mcp.openparley.dev` would be an extra Cloud-only entry point (an OAuth broker that asks for the workspace and routes by token), so it can be added later without changing any workspace URL.

## Next steps, in order

1. **Deployment.** Publish `openparley.js` to npm and a CDN; add a Dockerfile for sync. Left out of the rebuild until they can be tested end to end.
2. **Real-site trial.** Embed on two or three real staging sites and check anchor stability across deploys. The scoring thresholds in `overlay/src/anchor.ts` are the knobs.
3. **Notifications** (the existing milestone): email on mention or reply. Needs SMTP configuration on the server.
4. **Cloud sign-up and billing** on top of `ee/cloud`, once someone asks to pay for hosting. Add per-database backups before the first paying customer.
