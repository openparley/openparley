// `bun run dev`: the whole stack locally, with a seeded team server.
//   site        http://localhost:3000  (landing page = links-only demo, /team = team playground)
//   team server http://localhost:3001  (admin at /admin)
// The overlay is rebuilt whenever its source changes; both servers pick up the new build.
import { watch } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const SITE_PORT = Number(process.env.SITE_PORT ?? 3000);
const SYNC_PORT = Number(process.env.SYNC_PORT ?? 3001);
const syncEnv = {
  PORT: String(SYNC_PORT),
  PUBLIC_URL: `http://localhost:${SYNC_PORT}`,
  DATABASE_PATH: join(root, 'apps/sync/data/dev.db'),
  DEV_SITE_ORIGIN: `http://localhost:${SITE_PORT}`,
  // Invites and notifications go to this log; a short quiet period so notifications show up quickly.
  MAIL_LOG: '1',
  NOTIFY_QUIET_SECONDS: '10',
};

const children = new Set<Bun.Subprocess>();
let stopping = false;

function stopAll(code: number): never {
  stopping = true;
  for (const child of children) child.kill();
  process.exit(code);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

/** Long-running processes (`service`) take the whole dev setup down if they die; one-shot steps don't. */
function start(label: string, cmd: string[], env: Record<string, string> = {}, service = false): Bun.Subprocess {
  const child = Bun.spawn(cmd, { cwd: root, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  children.add(child);
  void prefix(label, child.stdout);
  void prefix(label, child.stderr);
  void child.exited.then((code) => {
    children.delete(child);
    if (service && !stopping) {
      console.error(`[${label}] exited with code ${code}; stopping everything.`);
      stopAll(code || 1);
    }
  });
  return child;
}

async function prefix(label: string, stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = stream.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    buffer += decoder.decode(read.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) console.log(`[${label}] ${line}`);
  }
}

async function buildOverlay(): Promise<boolean> {
  const code = await start('overlay', ['bun', 'packages/overlay/scripts/build.ts']).exited;
  return code === 0;
}

for (const [port, name] of [[SITE_PORT, 'SITE_PORT'], [SYNC_PORT, 'SYNC_PORT']] as const) {
  try {
    Bun.serve({ port, fetch: () => new Response() }).stop(true);
  } catch {
    console.error(`Port ${port} is already in use (another dev server?). Stop it, or pick another port: ${name}=<port> bun run dev`);
    process.exit(1);
  }
}

if (!(await buildOverlay())) stopAll(1);
if ((await start('seed', ['bun', 'apps/sync/src/dev-seed.ts'], syncEnv).exited) !== 0) stopAll(1);

start('site', ['bun', 'apps/site/serve.ts'], { PORT: String(SITE_PORT), EXTRA_STATIC_DIR: 'apps/site/dev', DEV_SYNC_URL: syncEnv.PUBLIC_URL }, true);
start('sync', ['bun', '--watch', 'apps/sync/src/main.ts'], syncEnv, true);

let timer: ReturnType<typeof setTimeout> | undefined;
let building = false;
let again = false;
const rebuild = async () => {
  if (building) {
    again = true;
    return;
  }
  building = true;
  await buildOverlay();
  building = false;
  if (again) {
    again = false;
    void rebuild();
  }
};
for (const dir of ['packages/overlay/src', 'packages/protocol/src']) {
  watch(join(root, dir), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 150);
  });
}

console.log(`
  Site            http://localhost:${SITE_PORT}          links-only demo
  Team playground http://localhost:${SITE_PORT}/team     overlay from the team server
  Team server     http://localhost:${SYNC_PORT}/admin    owner@openparley.test / openparley-dev
                                                    member@openparley.test / openparley-dev
  Data            apps/sync/data/dev.db (delete it to start over)
`);
