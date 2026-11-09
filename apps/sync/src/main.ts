import { loadConfig } from './config';
import { randomToken } from './crypto';
import { openInstance } from './instance';

const config = loadConfig();
const setupToken = process.env.SETUP_TOKEN || randomToken(16);
const { app, repo, close } = openInstance({ config, setupToken });

setInterval(() => repo.deleteExpiredSessions(), 6 * 60 * 60 * 1000);

const server = Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`OpenParley sync listening on ${server.url} (public URL ${config.publicUrl})`);
if (!repo.hasUsers()) {
  console.log(`\nFirst run: create the owner account at\n  ${config.publicUrl}/setup?token=${setupToken}\n`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.stop();
    close();
    process.exit(0);
  });
}
