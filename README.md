<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./packages/brand/logo-dark.svg">
    <img src="./packages/brand/logo-light.svg" alt="OpenParley" height="72">
  </picture>
</p>

<p align="center">Stop describing. Start pointing.</p>

OpenParley puts conversations on the elements of your live site. Point at what you mean and start a thread right there: your product team (PM, design, QA, development) replies in the thread, and your coding agent reads it over MCP, makes the change and replies too. Add one script tag to your site, then use [OpenParley Cloud](https://openparley.dev) or run the small self-hosted server. It also works without any server, with threads carried inside links, which is handy for a quick try.

## Try it

```bash
bun install
bun run dev
```

That starts everything, rebuilding the overlay as you edit:

| | |
|-|-|
| http://localhost:3000 | Landing page, which is also the links-only demo |
| http://localhost:3000/team | Team playground, talking to the local team server (`?launcher=members` tries production mode) |
| http://localhost:3001/admin | Team server admin |

Sign in as `owner@openparley.test` or `member@openparley.test` with password `openparley-dev`. Use a private window to be both at once. Data lives in `apps/sync/data/dev.db`; delete it to start over. Ports in use? `SITE_PORT=4000 SYNC_PORT=4001 bun run dev`.

## Use it on your site

**Links only.** Run `bun run build`, host the files in `packages/overlay/dist/` (a 1 KB loader, `openparley.js`, plus the overlay it fetches), and add:

```html
<script src="/openparley.js" defer></script>
```

**With a team server:**

```bash
bun run build
PUBLIC_URL=https://parley.example.com bun apps/sync/src/main.ts
```

Or with Docker behind your reverse proxy (data in the `openparley` volume):

```bash
docker build -f apps/sync/Dockerfile -t openparley-sync .
docker run -d -p 127.0.0.1:3001:3001 -v openparley:/data -e PUBLIC_URL=https://parley.example.com -e TRUST_PROXY=1 openparley-sync
docker logs <container>   # the setup link
```

Open the setup link the server prints, create a project for your site's origins, and paste the script tag from the admin page. On a production site, add `data-launcher="members"`: customers then download only the 1 KB loader, and the overlay appears only for people who have signed in to your OpenParley server. See [the docs page](apps/site/public/docs.html) for every option.

## Develop

```bash
bun run test        # overlay + server tests
bun run typecheck
bun run e2e         # Playwright, both modes
```

| Path | |
|------|-|
| `packages/overlay` | The embeddable UI: a 1 KB loader plus the overlay (Preact in a shadow root, ~21 KB gzipped) |
| `packages/protocol` | Shared data shapes |
| `apps/sync` | Self-hosted server (Bun, Hono, SQLite) |
| `ee/cloud` | Hosted version: many workspaces in one process, each an unmodified team server |
| `apps/site` | Landing page, demo and docs |

[ARCHITECTURE.md](ARCHITECTURE.md) explains how it works. [VISION.md](VISION.md) is the product direction. [REVIEW.md](REVIEW.md) explains why this codebase was rebuilt.

## License

OpenParley is open source under the [MIT license](LICENSE), with one exception: code in [`ee/`](ee/) (currently OpenParley Cloud) is under the [OpenParley Enterprise License](ee/LICENSE). Everything outside `ee/` works on its own; self-hosting with OpenParley Sync needs nothing from `ee/`.
