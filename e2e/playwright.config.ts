import { defineConfig, devices } from '@playwright/test';

export const SITE_URL = 'http://localhost:4173';
export const SYNC_URL = 'http://localhost:4174';
export const CLOUD_PORT = 4175;
export const CLOUD_DATA = '/tmp/openparley-e2e-cloud';
export const FAKE_POLAR_URL = 'http://localhost:4176';
const POLAR_SECRET = `whsec_${Buffer.from('openparley e2e webhook secret').toString('base64')}`;

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: SITE_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    { command: 'PORT=4173 EXTRA_STATIC_DIR=fixtures bun ../apps/site/serve.ts', url: SITE_URL, reuseExistingServer: false },
    {
      command: 'rm -f /tmp/openparley-e2e.db* && bun ../apps/sync/src/main.ts',
      url: `${SYNC_URL}/health`,
      reuseExistingServer: false,
      env: { PORT: '4174', PUBLIC_URL: SYNC_URL, DATABASE_PATH: '/tmp/openparley-e2e.db', SETUP_TOKEN: 'e2e-setup', MAIL_LOG: '1' },
    },
    {
      command: `rm -rf ${CLOUD_DATA} && bun ../ee/cloud/src/main.ts`,
      url: `http://cloud.localhost:${CLOUD_PORT}/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(CLOUD_PORT),
        CLOUD_DOMAIN: 'localhost',
        DATA_DIR: CLOUD_DATA,
        POLAR_ACCESS_TOKEN: 'e2e',
        POLAR_WEBHOOK_SECRET: POLAR_SECRET,
        POLAR_PRODUCT_TEAM: '00000000-0000-4000-8000-00000000000a',
        POLAR_API_URL: FAKE_POLAR_URL,
        POLAR_PORTAL_URL: `${FAKE_POLAR_URL}/portal`,
      },
    },
    {
      command: 'bun ../ee/cloud/dev/fake-polar.ts',
      url: `${FAKE_POLAR_URL}/test/subscriptions`,
      reuseExistingServer: false,
      env: { PORT: '4176', WEBHOOK_URL: `http://cloud.localhost:${CLOUD_PORT}/webhooks/polar`, WEBHOOK_SECRET: POLAR_SECRET },
    },
  ],
});
