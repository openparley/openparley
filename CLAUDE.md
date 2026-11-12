# OpenParley

OpenParley lets people click any element of a live website and start a discussion thread right there.

Read [VISION.md](VISION.md) for the product and [PRINCIPLES.md](PRINCIPLES.md) for how to think about scope. [ARCHITECTURE.md](ARCHITECTURE.md) describes how the code fits together; [REVIEW.md](REVIEW.md) explains why this codebase was rebuilt (Nov 2026) and the product decisions that differ from VISION.md.

**Plans and open decisions live in `.plans/` (gitignored, local only); operator runbooks such as `.docs/DEPLOY.md` live in `.docs/` (also gitignored).** Start with `.plans/README.md`: it lists what's next, what's undecided, and where each topic is written up. Update those files when a plan changes or ships; add a new `.plans/<topic>.md` for new work that spans sessions.

# Working in this repo

## Commands

```bash
bun install
bun run test        # licensing boundary check + overlay, sync and cloud tests (bun test)
bun run typecheck   # tsc for every package and the e2e suite
bun run e2e         # Playwright (Chromium): site :4173, throwaway sync :4174, cloud :4175, fake Polar :4176
bun run dev         # site :3000 (+ /team playground), seeded team server :3001, overlay rebuilt on change
                    # accounts: owner@openparley.test / member@openparley.test, password openparley-dev
bun run dev:cloud   # Cloud on :4000 with a fake Polar on :4010; sign up at http://cloud.localhost:4000,
                    # workspaces at http://<slug>.localhost:4000, emails go to the log
bun run cloud create acme "Acme"   # provision a workspace (also: list, suspend, resume, limits, setup-link, upgrade-link, signup-link)
```

Before calling a change done: `bun run typecheck && bun run test && bun run e2e`. For UI changes, also look at it: write a throwaway Playwright spec that takes screenshots, read the images, then delete the spec.

## Layout

| Path | License | What |
|------|---------|------|
| `packages/protocol` | MIT | Wire types (Anchor, Thread, Comment, API shapes). The single source of truth for data shapes. |
| `packages/overlay` | MIT | The embeddable UI. `dist/openparley.js` is a ~1 KB loader (`src/loader.ts` + `src/gate.ts`) that fetches the content-hashed `openparley-app-<hash>.js` (Preact in a shadow root) only when needed. |
| `packages/brand` | MIT (fonts: OFL) | Logos (`logo-light.svg` for light backgrounds, `logo-dark.svg` for dark, `icon.svg`), self-hosted Plus Jakarta Sans, and Instrument Serif Italic (site headings only: one emphasised phrase per heading). Served under `/brand/` by the site and the team server. |
| `apps/sync` | MIT | Self-hosted team server (OpenParley Sync): Hono + `bun:sqlite`, one process + one SQLite file = one organization. Also a library (`createApp`, `openInstance`) used by Cloud. |
| `apps/site` | MIT | Static landing page (doubles as the links-only demo) and docs. `site.js` loads the `dogfood` workspace instead when a browser opens it with `?dogfood=true` (`?dogfood=false` to leave). `apps/site/dev/` holds dev-only pages, never built. For coding agents it serves `llms.txt` and generates `docs.md`, `setup.md` and `llms-full.txt` from `docs.html` and the setup prompt (`apps/sync/src/setup-prompt.ts`, also on each project's admin page). |
| `ee/cloud` | Enterprise | OpenParley Cloud: one process routes `<slug>.<domain>` to an unmodified Sync instance per workspace (own SQLite file), plus a control plane (`control.db`). |
| `e2e` | MIT | Playwright tests; `e2e/fixtures/` are test pages served by the site server. |

## Open source vs enterprise (PostHog model)

- Everything is MIT except `ee/`, which is under `ee/LICENSE` (OpenParley Enterprise License: source-available, production use needs an agreement). The root `LICENSE` explains the split.
- **Dependencies only point into the open core:** `ee/` may import MIT packages; nothing outside `ee/` may import from `ee/`. `scripts/check-boundaries.ts` enforces this in `bun run test`.
- **Self-hosting must be complete without `ee/`.** A feature belongs in `ee/` only if it is about running OpenParley as a hosted business (tenancy, sign-up, billing, provisioning, plan management). Collaboration features go in the open core, even when Cloud is the first to sell them.
- New enterprise packages: `ee/<name>/` with `"private": true` and `"license": "SEE LICENSE IN ../LICENSE"`.

## Rules that keep it stable

- **Sync stays single-organization and billing-free.** Never add a tenant or org column; Cloud gets isolation from one database file per workspace. Plan logic belongs in `ee/cloud` and reaches Sync only as generic `limits` (`MAX_MEMBERS`, `MAX_PROJECTS`, `MAX_THREADS`).
- **Billing follows the subscription's `status`, not the webhook type.** Polar's `subscription.canceled` means "ends at period end" (still paid for); only `revoked`/status `canceled` ends the paid plan. An ended subscription drops the workspace to Free (data kept, new threads capped); billing never pauses a workspace, only an operator does. Keep webhook handling idempotent (delivery id) and order-safe (`modified_at`).
- **Shapes live in `packages/protocol`.** Changing one is a breaking change for stored data and share links; bump the version. `apps/sync/test/api.test.ts` checks server output against the overlay's own validator.
- **Migrations are append-only** (`apps/sync/src/db.ts` and `ee/cloud/src/control.ts`, tracked with `PRAGMA user_version`). Never edit one that shipped; Cloud runs every workspace database through them on open.
- **A project's origin list is a security boundary:** only listed origins get a token from the sign-in popup. Admins widen it deliberately (admin page, or one click in the popup for the exact origin); never add sites automatically or for members.
- **Untrusted input is validated at the edge:** share links in `overlay/src/share.ts` (`isThread`), API bodies in `sync/src/validation.ts` (zod). Comment text is always rendered as text, never HTML or autolinked.
- **Overlay styling** is plain CSS in `overlay/src/ui/styles.css`, isolated by the shadow root. No Tailwind, no CSS frameworks. Use the `--op-*` custom properties.
- **Positioning:** overlay elements are `position: fixed` and follow page elements through `Tracker` (one rAF pass, direct style writes). Don't move per-frame positions into component state. Cards are placed by `ui/Floating.tsx`: beside the element, never over it, never under the toolbar.
- **Bundle budgets:** `scripts/build.ts` fails if the loader exceeds 2 KB or the app 32 KB gzipped (app is ~30.6 KB now). The loader budget is the one that matters (every visitor pays it); the app's is a tripwire against accidental bloat, raise it deliberately when a feature needs room. Fonts are separate files and don't count. The loader ships to every visitor: keep `gate.ts` and `loader.ts` dependency-free.
- **Notifications are channel-agnostic.** Recipient rules and batching (`sync/src/notify.ts`) know nothing about email; a new channel (Slack, Teams) is one more `Channel`. Mentions stay plain `@handle` (or `@Full Name`) text resolved on the server, never a protocol field; the overlay only highlights them. Nobody is notified about their own (or their agent's) actions.
- **Touch** is decided per event from `PointerEvent.pointerType` (or `(hover: none)`/`(pointer: coarse)` in CSS), never from the user agent. Below 600px wide, cards are a bottom sheet placed by the same `Floating` (`SHEET_QUERY` and the `@media` block in `styles.css` must agree).
- **Keyboard shortcuts:** single keys, never when a field has focus, never with modifiers held. Only the comment key (`shortcut.ts`, default `c`, configurable via `data-shortcut`) is global, and it yields to the host page (`preventDefault`/`stopPropagation` win) unless `shortcutPriority: 'openparley'`. All others (`Esc`, `J`/`K`) only while the overlay is open. Key labels live in `ui/keys.tsx`.
- **Never trust the host page.** The overlay runs on other people's sites: no globals, no host CSS assumptions, nothing that breaks under a strict CSP (we degrade: inline SVGs, system-font fallback).
- **Comments in code** only for non-obvious reasons and constraints, never to narrate what the code does.

## Things that bit us (don't relearn them)

- **Bun's CSS minifier rounds big integers** (`z-index: 2147483647` became `2147480000`). The overlay build strips whitespace only; don't switch it back to `Bun.build` CSS minification.
- **Nested `Bun.build` inside a Bun build plugin deadlocks.** Do CSS work before the main build (see `scripts/build.ts`).
- **`autofocus` is unreliable inside a shadow root.** Focus explicitly with `focus({ preventScroll: true })` in a layout effect.
- **`@font-face` does nothing inside a shadow root.** `overlay/src/font.ts` injects one rule into the host document under the private family `OpenParley Sans`.
- **Hover `scale` + positioning via `transform` moves the element** (the scale applies to the translation). Position with the `translate` property; keep `transform`/`scale` for effects.
- **A tap's click can only be cancelled from `touchend`** (`preventDefault()`), not from pointer events. Decide taps there (`ui/tap.ts`): picking on `pointerup` unmounts the Picker before the click arrives, so the page gets it.
- **Image (SVG) cursors render unreliably across browsers.** Pick mode hides the cursor and draws a pin that follows the pointer instead.
- **JSX runtime for the sync server** is set per file with `/** @jsxImportSource hono/jsx */`, so it doesn't depend on the current working directory's tsconfig.
- **Chrome blocks a routed (faked) page from calling a loopback server** (private network access). E2E pages that talk to local servers are real files in `e2e/fixtures/`.
- **Playwright is pinned to 1.58.2** to match the locally installed Chromium. Upgrading means `bunx playwright install`.
- **`*.localhost` resolves to the local machine in Chrome**, which is how Cloud workspaces (`acme.localhost:4000`) work in dev and e2e without DNS.
- **Flaky tests are almost always test bugs here** (the overlay remembers being open for the browser session; a popup can close before a `close` listener attaches). Reproduce with `--repeat-each`, read the error context, fix the cause; never add retries or sleeps to hide it.

## Working style for this repo

- The user reviews visually: after UI changes, report what was checked with screenshots, and say plainly what couldn't be verified (e.g. real cursors, other browsers).
- Chromium is the only browser tested so far.
- Commit in focused steps with descriptive messages.
