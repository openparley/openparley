import { Cloud } from './cloud';
import { loadCloudConfig, urlFor } from './config';

const config = loadCloudConfig();
const cloud = new Cloud(config);
const server = Bun.serve({ port: config.port, fetch: cloud.fetch });

console.log(`OpenParley Cloud listening on ${server.url}`);
console.log(`  control plane  ${urlFor(config, `cloud.${config.domain}`)}`);
console.log(`  workspaces     ${urlFor(config, `<slug>.${config.domain}`)}  (${cloud.stats().workspaces} provisioned)`);
console.log(`  sign-up        ${config.polar ? `open (Polar at ${config.polar.apiUrl})` : 'closed (set POLAR_* to open it)'}`);
if (config.polar && !config.mail) console.warn('  warning: no RESEND_API_KEY, so setup links are emailed to this log instead of to customers');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.stop();
    cloud.close();
    process.exit(0);
  });
}
