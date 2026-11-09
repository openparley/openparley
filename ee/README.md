# Enterprise (`ee/`)

Code in this directory is **not** MIT licensed. It is covered by the [OpenParley Enterprise License](LICENSE): you may read it, run it to develop and test, and contribute to it, but production use needs an agreement with OpenParley.

Everything outside `ee/` is MIT and must keep working without it. The dependency only goes one way: `ee/` may import the open-source packages, never the reverse.

| Package | What |
|---------|------|
| `cloud` | OpenParley Cloud: hosts many workspaces in one process, each an unmodified OpenParley Sync instance. |
