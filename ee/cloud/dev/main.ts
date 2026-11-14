// `bun run dev:cloud`: Cloud with sign-up open against the fake Polar server, unless real Polar
// (sandbox) credentials are in the environment, and a fake GitHub unless GITHUB_CLIENT_ID is set. Emails go to the log.
import { startFakeGithub } from '../../../apps/sync/dev/fake-github';
import { startFakePolar } from './fake-polar';

const env = process.env;
if (!env.POLAR_ACCESS_TOKEN) {
  const port = Number(env.FAKE_POLAR_PORT ?? 4010);
  const secret = `whsec_${Buffer.from('openparley fake polar dev secret').toString('base64')}`;
  Object.assign(env, {
    POLAR_ACCESS_TOKEN: 'fake',
    POLAR_WEBHOOK_SECRET: secret,
    POLAR_PRODUCT_TEAM: '00000000-0000-4000-8000-00000000000a',
    POLAR_API_URL: `http://localhost:${port}`,
    POLAR_PORTAL_URL: `http://localhost:${port}/portal`,
  });
  const webhookUrl = `http://cloud.${env.CLOUD_DOMAIN ?? 'localhost'}:${env.PORT ?? 4000}/webhooks/polar`;
  const server = startFakePolar({ port, webhookUrl, webhookSecret: secret });
  console.log(`Fake Polar on ${server.url} (set POLAR_* to use the real sandbox instead)`);
}

if (!env.GITHUB_CLIENT_ID) {
  const github = startFakeGithub({ port: Number(env.FAKE_GITHUB_PORT ?? 4011) });
  Object.assign(env, { GITHUB_CLIENT_ID: 'fake', GITHUB_CLIENT_SECRET: 'fake', GITHUB_WEB_URL: github.url.origin, GITHUB_API_URL: github.url.origin });
  console.log(`Fake GitHub on ${github.url.origin} (users: olivia-dev, mia-dev, sam-unverified; set GITHUB_CLIENT_ID/SECRET for a real app)`);
}

await import('../src/main');
