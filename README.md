<p align="center">
  <a href="https://openparley.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./packages/brand/logo-dark.svg">
      <img src="./packages/brand/logo-light.svg" alt="OpenParley" height="64">
    </picture>
  </a>
</p>

<p align="center"><strong>Stop describing. Start pointing.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT%20(core)-2C7F6B" alt="License: MIT (core), ee/ source-available"></a>
  <a href="https://github.com/openparley/openparley/actions/workflows/ci.yml"><img src="https://github.com/openparley/openparley/actions/workflows/ci.yml/badge.svg?branch=master" alt="CI"></a>
</p>

<p align="center">
  <a href="https://openparley.dev">Website</a> ·
  <a href="https://openparley.dev/docs">Docs</a> ·
  <a href="https://cloud.openparley.dev">Cloud</a> ·
  <a href="https://openparley.dev/docs#server">Self-hosting</a>
</p>

OpenParley puts conversations on the elements of your live site. Point at what you mean and start a thread right there: your product team (PM, design, QA, development) replies in the thread, and your coding agent reads it over MCP, makes the change and replies too.

- **Point, don't describe.** Press <kbd>C</kbd>, click an element, write. The thread stays on that element.
- **Your agent is in the thread.** Claude Code, Cursor, VS Code and other MCP clients sign in with one command, read open threads, ship the fix and reply.
- **Invisible to customers.** With `data-launcher="members"`, visitors download a 1 KB loader and nothing else; only teammates who signed in get the overlay.
- **Yours to run.** Use [OpenParley Cloud](https://cloud.openparley.dev), or self-host one small server: a Bun process and a SQLite file.

Try it on [openparley.dev](https://openparley.dev): press <kbd>C</kbd> on the page.

## Use it

**Cloud.** [Start free](https://cloud.openparley.dev/signup), create a project for your site, paste the script tag from the admin page and connect your agent. The [docs](https://openparley.dev/docs#start) walk through it.

**Self-host.** Requires [Bun](https://bun.sh) 1.4 or Docker.

```bash
git clone https://github.com/openparley/openparley
cd openparley
bun install
bun run build
PUBLIC_URL=https://parley.example.com bun apps/sync/src/main.ts
```

Or with Docker behind your reverse proxy (data in the `openparley` volume):

```bash
docker build -f apps/sync/Dockerfile -t openparley-sync .
docker run -d -p 127.0.0.1:3001:3001 -v openparley:/data -e PUBLIC_URL=https://parley.example.com -e TRUST_PROXY=1 openparley-sync
docker logs <container>   # the setup link
```

Open the setup link the server prints, create a project for your site's origins and paste the script tag from the admin page. See [Self-hosting](https://openparley.dev/docs#server) for every setting.

**Links only, no server.** Run `bun run build`, host the files in `packages/overlay/dist/` and add `<script src="/openparley.js" defer></script>`. Threads travel inside links; handy for a quick try.

## Develop

```bash
bun install
bun run dev
```

| | |
|-|-|
| http://localhost:3000 | Landing page, which is also the links-only demo |
| http://localhost:3000/team | Team playground, talking to the local team server (`?launcher=members` tries production mode) |
| http://localhost:3001/admin | Team server admin |

Sign in as `owner@openparley.test` or `member@openparley.test` with password `openparley-dev`; use a private window to be both at once. Data lives in `apps/sync/data/dev.db`; delete it to start over. Ports in use? `SITE_PORT=4000 SYNC_PORT=4001 bun run dev`.

```bash
bun run test        # boundary check, overlay, server and cloud tests
bun run typecheck
bun run e2e         # Playwright (Chromium)
```

| Path | |
|------|-|
| `packages/overlay` | The embeddable UI: a 1 KB loader plus the overlay (Preact in a shadow root, ~28 KB gzipped) |
| `packages/protocol` | Shared data shapes |
| `packages/brand` | Logos and fonts |
| `apps/sync` | Self-hosted server (Bun, Hono, SQLite), with the MCP endpoint for agents |
| `apps/site` | Landing page, demo and docs |
| `ee/cloud` | Hosted version: many workspaces in one process, each an unmodified team server |

[ARCHITECTURE.md](ARCHITECTURE.md) explains how it works, [PRINCIPLES.md](PRINCIPLES.md) how scope is decided, and [REVIEW.md](REVIEW.md) why this codebase was rebuilt.

## Contributing

OpenParley isn't accepting pull requests yet. Bug reports and ideas are welcome in [issues](https://github.com/openparley/openparley/issues). To report a security problem, use [private vulnerability reporting](https://github.com/openparley/openparley/security/advisories/new) or email support@openparley.dev.

## License

OpenParley is open source under the [MIT license](LICENSE), with one exception: code in [`ee/`](ee/) (currently OpenParley Cloud) is under the [OpenParley Enterprise License](ee/LICENSE). Everything outside `ee/` works on its own; self-hosting needs nothing from `ee/`.
