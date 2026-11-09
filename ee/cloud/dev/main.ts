// `bun run dev:cloud`: Cloud with sign-up open against the fake Polar server, unless real Polar
// (sandbox) credentials are in the environment. Emails go to the log.
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

await import('../src/main');
