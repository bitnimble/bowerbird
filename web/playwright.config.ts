import { defineConfig } from '@playwright/test';
import { API_PORT, API_URL, DB_PATH, WEB_PORT, prepareFixture } from './e2e/fixture_library';

prepareFixture();

// Drives the real stack: the Hono API (which needs LibRaw for RAW decoding) and
// the Vite dev server, both on dedicated ports so a running dev session is not
// disturbed.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'bun run src/index.ts',
      cwd: '..',
      url: `${API_URL}/api/libraries`,
      reuseExistingServer: false,
      env: {
        DB_PATH,
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
        // The daily reconcile would be a stray timer in a test run.
        SYNC_FULL_AT: '',
      },
    },
    {
      command: `./node_modules/.bin/vite --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { VITE_API_URL: API_URL },
    },
  ],
});
